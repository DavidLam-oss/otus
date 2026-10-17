#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { defaultConfig, DATA_DIR } from "./config.ts";
import { ActivityStore } from "./store.ts";
import { ActivityRecorderService } from "./recorder.ts";
import { ActivityAnalyzer } from "./analyzer.ts";
import { ActivitySummarizer } from "./summarizer.ts";
import { ActivityRotator } from "./rotator.ts";
import { ReportRenderer } from "./report.ts";

const PID_FILE = path.join(DATA_DIR, "otus.pid");

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

      // 定时日终报告生成器：每 30 分钟检查一次，若在晚间 21:00 之后自动生成当天的 HTML 报告与数据库总结
      const summarizer = new ActivitySummarizer(store, defaultConfig);
      const renderer = new ReportRenderer(store, defaultConfig);
      const autoReportTimer = setInterval(() => {
        const now = new Date();
        const hour = now.getHours();
        // 晚间 21:00 至 23:59 自动静默生成当天日终报告
        if (hour >= 21) {
          renderer.renderHtmlReport().catch((err) =>
            console.error("[Otus] Auto evening report generation error:", err)
          );
        }
      }, 30 * 60 * 1000);

      const shutdown = () => {
        console.log("\n[Otus] Graceful shutdown initiated...");
        clearInterval(autoReportTimer);
        recorder.stop();
        analyzer.stop();
        rotator.stop();
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

      const today = new Date().toISOString().slice(0, 10);
      const [year, month, day] = today.split("-").map(Number);
      const startOfDay = new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
      const endOfDay = new Date(year, month - 1, day + 1, 0, 0, 0, 0).getTime();

      const sessions = store.listSessions({ since: startOfDay, until: endOfDay, limit: 1000 });
      const analyzed = sessions.filter((s) => s.analysisStatus === "analyzed");
      const totalMs = sessions.reduce((acc, s) => acc + (s.durationMs || 0), 0);

      console.log("=========================================");
      console.log(` Otus Status · ${today}`);
      console.log("=========================================");
      console.log(`Daemon Running:  ${isRunning ? `YES (PID: ${pid})` : "NO"}`);
      console.log(`Database:        ${defaultConfig.dbPath}`);
      console.log(`Today Sessions:  ${sessions.length} (Analyzed: ${analyzed.length})`);
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
      console.log("[Otus] Running micro-session analyzer on pending sessions...");
      const analyzer = new ActivityAnalyzer(store, defaultConfig);
      const res = await analyzer.runOnce();
      console.log(`[Otus] Analyzed: ${res.analyzed}, Processed: ${res.processed}, Failed: ${res.failed}`);
      break;
    }

    case "report": {
      const dateKey = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
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
      const dateKey = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      const renderer = new ReportRenderer(store, defaultConfig);
      const { outputPath } = await renderer.renderHtmlReport(dateKey);
      console.log(`[Otus] HTML Report generated: ${outputPath}`);
      try {
        execSync(`open "${outputPath}"`);
      } catch {}
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
