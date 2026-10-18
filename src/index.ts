#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { defaultConfig, DATA_DIR, getLocalDateKey } from "./config.ts";
import { ActivityStore } from "./store.ts";
import { ActivityRecorderService } from "./recorder.ts";
import { ActivityAnalyzer } from "./analyzer.ts";
import { ActivitySummarizer } from "./summarizer.ts";
import { ActivityRotator } from "./rotator.ts";
import { ReportRenderer } from "./report.ts";
import { sendDesktopNotification } from "./notifier.ts";

const PID_FILE = path.join(DATA_DIR, "otus.pid");

function resolveDateKey(input?: string): string | undefined {
  if (!input) return undefined;
  if (input === "yesterday" || input === "yd") {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return input;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "status";

  const store = new ActivityStore(defaultConfig.dbPath);

  switch (command) {
    case "daemon":
    case "start": {
      if (fs.existsSync(PID_FILE)) {
        const oldPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
        try {
          process.kill(oldPid, 0);
          console.log(`[Otus] Daemon is already running (PID: ${oldPid})`);
          return;
        } catch {
          // PID 文件失效，移除
          fs.unlinkSync(PID_FILE);
        }
      }

      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(PID_FILE, String(process.pid), "utf-8");

      console.log(`[Otus] Starting background daemon (PID: ${process.pid})...`);
      const recorder = new ActivityRecorderService(store, defaultConfig);
      const analyzer = new ActivityAnalyzer(store, defaultConfig, () => recorder.isUserActive());
      const rotator = new ActivityRotator(store, defaultConfig);

      // 会话关闭时通知微会话分析器
      recorder.onSessionClosed = () => {
        analyzer.runOnce().catch((err) => console.error("[Otus] Analyzer runOnce failed:", err));
      };

      await recorder.start();
      analyzer.start();
      rotator.start();

      // 启动顶部菜单栏常驻小夜枭 (Menu Bar Item)
      const menuBarBin = path.join(import.meta.dirname, "../bin/otus-menu-bar");
      const appMenuBarBin = "/Applications/Otus.app/Contents/Resources/app/bin/otus-menu-bar";
      const targetMenuBin = fs.existsSync(appMenuBarBin) ? appMenuBarBin : menuBarBin;
      let menuProc: any = null;

      if (fs.existsSync(targetMenuBin)) {
        try {
          menuProc = spawn(targetMenuBin, [], { detached: true, stdio: "ignore" });
          menuProc.unref();
        } catch (err) {
          console.error("[Otus] Failed to start menu bar process:", err);
        }
      }

      // 日终报告与昨日自动补漏生成器
      const summarizer = new ActivitySummarizer(store, defaultConfig);
      const renderer = new ReportRenderer(store, defaultConfig);

      const checkAndBackfillYesterdayReport = async () => {
        try {
          const now = new Date();
          const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
          const yKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;

          const startOfYesterday = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 0, 0, 0).getTime();
          const endOfYesterday = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate() + 1, 0, 0, 0).getTime();

          // 检查昨天是否有记录的 session
          const ySessions = store.listSessions({ since: startOfYesterday, until: endOfYesterday, limit: 1 });
          if (ySessions.length === 0) return;

          // 检查昨天的 HTML 报告是否已落盘导出
          const reportPath = path.join(defaultConfig.outputDir, "reports", `${yKey}.html`);
          if (!fs.existsSync(reportPath)) {
            console.log(`[Otus] Catch-up: Detected missing daily report for yesterday (${yKey}). Generating in background...`);
            await renderer.renderHtmlReport(yKey);
            console.log(`[Otus] Catch-up: Successfully generated report for ${yKey}`);

            const summary = store.getSummary("daily", yKey);
            const stats = summary?.stats?.reportStats || {};
            sendDesktopNotification({
              title: "🦉 Otus 个人折腾日记",
              subtitle: `${yKey} 报告已自动就绪`,
              message: `昨日活跃 ${stats.totalActiveMinutes || 0}m，${stats.analyzedCount || 0} 个实质折腾已归类为 ${stats.clusterCount || 0} 个核心主题。`
            });
          }
        } catch (err) {
          console.error("[Otus] Catch-up report generation error:", err);
        }
      };

      // 1. 守护进程启动后延迟 5 秒检查一次昨日报告
      setTimeout(() => {
        checkAndBackfillYesterdayReport().catch(() => {});
      }, 5000);

      // 2. 电脑休眠唤醒 / 屏幕解锁时，自动触发补漏检查
      recorder.onWake = () => {
        checkAndBackfillYesterdayReport().catch(() => {});
      };

      // 3. 定时巡检：每 30 分钟检查一次（晚间 21:00+ 生成当天报告，同时自动补漏昨日报告）
      const autoReportTimer = setInterval(() => {
        const now = new Date();
        const hour = now.getHours();
        // 晚间 21:00 至 23:59 自动静默生成当天日终报告并推送系统通知
        if (hour >= 21) {
          renderer.renderHtmlReport().then(() => {
            const today = getLocalDateKey(now);
            const summary = store.getSummary("daily", today);
            const stats = summary?.stats?.reportStats || {};
            sendDesktopNotification({
              title: "🦉 Otus 个人折腾日记",
              subtitle: "今日日终报告已生成",
              message: `今日活跃 ${stats.totalActiveMinutes || 0}m，${stats.analyzedCount || 0} 个实质折腾已归类为 ${stats.clusterCount || 0} 个核心主题。`
            });
          }).catch((err) =>
            console.error("[Otus] Auto evening report generation error:", err)
          );
        }
        // 白天及任意时段检查昨日报告是否有遗漏未生成（如昨夜提前合盖或关机）
        checkAndBackfillYesterdayReport().catch(() => {});
      }, 30 * 60 * 1000);

      const shutdown = () => {
        console.log("\n[Otus] Graceful shutdown initiated...");
        clearInterval(autoReportTimer);
        recorder.stop();
        analyzer.stop();
        rotator.stop();
        if (menuProc && !menuProc.killed) {
          try { menuProc.kill("SIGTERM"); } catch {}
        }
        try { execSync("pkill -f otus-menu-bar 2>/dev/null"); } catch {}
        try {
          if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
        } catch {}
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      break;
    }

    case "stop": {
      try { execSync("pkill -f otus-menu-bar 2>/dev/null"); } catch {}
      if (!fs.existsSync(PID_FILE)) {
        console.log("[Otus] No active daemon running.");
        return;
      }
      const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
      try {
        process.kill(pid, "SIGTERM");
        console.log(`[Otus] Stopped daemon process (PID: ${pid})`);
      } catch (err: any) {
        console.log(`[Otus] Process ${pid} not running or already terminated: ${err.message}`);
      }
      try { fs.unlinkSync(PID_FILE); } catch {}
      break;
    }

    case "status": {
      let isRunning = false;
      let pid: number | null = null;
      if (fs.existsSync(PID_FILE)) {
        pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
        try {
          process.kill(pid, 0);
          isRunning = true;
        } catch {
          isRunning = false;
        }
      }

      const today = getLocalDateKey();
      const [year, month, day] = today.split("-").map(Number);
      const startOfDay = new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
      const endOfDay = new Date(year, month - 1, day + 1, 0, 0, 0, 0).getTime();

      const sessions = store.listSessions({ since: startOfDay, until: endOfDay, limit: 1000 });
      const analyzed = sessions.filter((s) => s.analysisStatus === "analyzed");
      const notWorth = sessions.filter((s) => s.analysisStatus === "not_worth");
      const failed = sessions.filter((s) => s.analysisStatus === "failed");
      const pending = sessions.filter((s) => s.analysisStatus === "pending");
      const totalMs = sessions.reduce((acc, s) => acc + (s.durationMs || 0), 0);

      console.log("=========================================");
      console.log(` Otus Status · ${today}`);
      console.log("=========================================");
      console.log(`Daemon Running:  ${isRunning ? `YES (PID: ${pid})` : "NO"}`);
      console.log(`Database:        ${defaultConfig.dbPath}`);
      console.log(
        `Today Sessions:  ${sessions.length} (${analyzed.length} analyzed, ${notWorth.length} idle filtered${failed.length ? `, ${failed.length} failed` : ""}${pending.length ? `, ${pending.length} pending` : ""})`
      );
      console.log(`Active Minutes:  ${Math.round(totalMs / 60000)}m`);

      const openSessions = store.listOpenSessions();
      if (openSessions.length > 0) {
        const cur = openSessions[0];
        const curDur = Math.round((Date.now() - cur.startedAt) / 1000);
        console.log(`Current Session: ${cur.id} (Active ${curDur}s, App: ${cur.appNames.join(", ") || "Unknown"})`);
      }
      console.log("=========================================");
      break;
    }

    case "analyze": {
      const all = args.includes("--all");
      console.log(`[Otus] Running micro-session analyzer${all ? " (processing all pending and failed sessions)" : ""}...`);
      const analyzer = new ActivityAnalyzer(store, defaultConfig);

      let totalProcessed = 0;
      let totalAnalyzed = 0;
      let totalFailed = 0;

      while (true) {
        const res = await analyzer.runOnce({ limit: all ? 50 : 20 });
        totalProcessed += res.processed;
        totalAnalyzed += res.analyzed;
        totalFailed += res.failed;

        if (res.processed === 0 || !all) break;
        console.log(`[Otus] Progress: ${totalAnalyzed} analyzed, ${totalProcessed} processed...`);
      }

      console.log(`[Otus] Done. Analyzed: ${totalAnalyzed}, Processed: ${totalProcessed}, Failed: ${totalFailed}`);
      break;
    }

    case "report": {
      const dateKey = resolveDateKey(args[1] && !args[1].startsWith("--") ? args[1] : undefined);
      const force = args.includes("--force");
      const json = args.includes("--json");
      const summarizer = new ActivitySummarizer(store, defaultConfig);
      const res = await summarizer.generateDailyReport(dateKey, { force });

      if (json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(res.markdown);
      }
      break;
    }

    case "export": {
      const dateKey = resolveDateKey(args[1] && !args[1].startsWith("--") ? args[1] : undefined);
      const force = args.includes("--force");
      const renderer = new ReportRenderer(store, defaultConfig);
      const { outputPath } = await renderer.renderHtmlReport(dateKey, { force });
      console.log(`[Otus] HTML Report generated: ${outputPath}`);
      try {
        execSync(`open "${outputPath}"`);
      } catch {}
      break;
    }

    case "open-latest": {
      const reportsDir = path.join(defaultConfig.outputDir, "reports");
      fs.mkdirSync(reportsDir, { recursive: true });
      const htmlFiles = fs
        .readdirSync(reportsDir)
        .filter((f) => f.endsWith(".html"))
        .sort()
        .reverse();

      if (htmlFiles.length > 0) {
        const latestPath = path.join(reportsDir, htmlFiles[0]);
        console.log(`[Otus] Opening latest report: ${latestPath}`);
        try { execSync(`open "${latestPath}"`); } catch {}
      } else {
        const renderer = new ReportRenderer(store, defaultConfig);
        const { outputPath } = await renderer.renderHtmlReport();
        console.log(`[Otus] Generated and opening report: ${outputPath}`);
        try { execSync(`open "${outputPath}"`); } catch {}
      }
      break;
    }

    case "test-capture": {
      console.log("[Otus] Testing capture and Vision OCR on active screen...");
      const recorder = new ActivityRecorderService(store, defaultConfig);
      await (recorder as any).ensureSwiftBinaries();
      (recorder as any).isRunning = true;
      await recorder.maybeCapture("manual_test");
      const sessions = store.listSessions({ limit: 5 });
      const latest = sessions[sessions.length - 1];
      if (latest) {
        const ocrs = store.listOcrForSession(latest.id, 5);
        console.log(`[Otus] Captured session: ${latest.id}`);
        console.log(`[Otus] OCR frames found: ${ocrs.length}`);
        for (const o of ocrs) {
          console.log(`--- [OCR text preview (${o.charCount} chars)] ---`);
          console.log(o.text.slice(0, 300));
        }
      } else {
        console.log("[Otus] No session created.");
      }
      break;
    }

    default: {
      console.log(`
Usage: otus <command> [options]

Commands:
  daemon, start       Start background recording daemon
  stop                Stop background recording daemon
  status              Check daemon status & today's session summary
  report [dateKey]    Print daily tinkering journal markdown (e.g. 2026-10-17)
  export [dateKey]    Generate & open HTML daily flow report in browser
  test-capture        Take an immediate snapshot & test native Vision OCR
      `);
      break;
    }
  }
}

main().catch((err) => {
  console.error("[Otus Fatal Error]", err);
  process.exit(1);
});
