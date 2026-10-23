#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { defaultConfig, DATA_DIR, CONFIG_FILE, saveUserConfig, getEffectiveConfig, getLocalDateKey, type OtusConfig } from "./config.ts";
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
  if (input === "today" || input === "td") {
    return getLocalDateKey();
  }
  // 严格校验 YYYY-MM-DD，避免 "--force" 等 flag 被当作日期写入数据库
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    console.warn(`[Otus] 忽略非法日期参数 "${input}"，回退到今日。`);
    return undefined;
  }
  // 校验日期真实存在（拒绝 2026-02-31 这类）
  const [y, m, d] = input.split("-").map(Number);
  const probe = new Date(y, m - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) {
    console.warn(`[Otus] 日期 "${input}" 不存在，回退到今日。`);
    return undefined;
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

      // 3. 定时巡检：每 1 分钟检测一次
      // 晚间 23:50 自动触发当天的全天日终报告（每天仅自动生成 1 次，完整收纳晚间下班后的全部折腾活动）
      let lastAutoReportDateKey = "";

      const autoReportTimer = setInterval(() => {
        const now = new Date();
        const hour = now.getHours();
        const minute = now.getMinutes();
        const today = getLocalDateKey(now);

        // 每天 23:50 起自动触发当天的全天折腾终版报告（仅触发 1 次）
        if (hour === 23 && minute >= 50 && lastAutoReportDateKey !== today) {
          lastAutoReportDateKey = today;
          renderer.renderHtmlReport(today, { force: true }).then(() => {
            const summary = store.getSummary("daily", today);
            const stats = summary?.stats?.reportStats || {};
            sendDesktopNotification({
              title: "🦉 Otus 个人折腾日记",
              subtitle: "今日日终心流报告已就绪",
              message: `今日活跃 ${stats.totalActiveMinutes || 0}m，${stats.analyzedCount || 0} 个实质折腾已归类为 ${stats.clusterCount || 0} 个核心主题。`
            });
          }).catch((err) => {
            console.error("[Otus] Auto evening report generation error:", err);
            // 失败时允许重试
            lastAutoReportDateKey = "";
          });
        }

        // 每隔 15 分钟检查一次昨日报告补漏（如昨夜提前休眠合盖）
        if (minute % 15 === 0) {
          checkAndBackfillYesterdayReport().catch(() => {});
        }
      }, 60 * 1000);

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

    case "recompute-signals": {
      // 回填存量会话的 signals.activity。
      //
      // 为什么需要：信号是在会话闭合时派生并落库的，之后新增了计算字段
      // （如切换质量 revisitSwitches / newAppSwitches），
      // 老会话不会自动补上，于是 summarizer 拿不到这些字段，
      // 提示词里「revisitSwitches 高 = 工具链循环」那套判断对历史数据全部失效。
      const days = Number(args[1] && !args[1].startsWith("--") ? args[1] : 7);
      const since = Date.now() - days * 24 * 3600 * 1000;
      // listSessions 把 limit 钳在 2000，长历史要分页扫完，不能只处理第一批。
      let done = 0;
      let scanned = 0;
      let cursor: number = since;
      for (;;) {
        const batch = store.listSessions({ since: cursor, limit: 2000 });
        if (batch.length === 0) break;
        for (const s of batch) {
          try {
            store.updateSessionSignals(s.id);
            done++;
          } catch (e) {
            console.warn(`[Otus] 会话 ${s.id} 信号重算失败：`, String((e as any)?.message || e));
          }
        }
        scanned += batch.length;
        const lastAt = Number(batch[batch.length - 1].startedAt);
        // 没有推进（同毫秒多条）时强制 +1，避免死循环
        cursor = lastAt > cursor ? lastAt + 1 : cursor + 1;
        if (cursor > Date.now()) break;
        if (batch.length < 2000) break;
      }
      console.log(`[Otus] 已重算 ${done}/${scanned} 个会话的行为信号（近 ${days} 天）`);
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

      // 生成报告前先补齐未分析的会话。
      // 背景：generateDailyReport 只读取 analysis_status='analyzed' 的会话，
      // pending 的会被静默丢弃——用户看到的就是「最近的折腾没出现在报告里」。
      const targetDay = dateKey || getLocalDateKey();
      const [ty, tm, td] = targetDay.split("-").map(Number);
      const dayStart = new Date(ty, tm - 1, td, 0, 0, 0, 0).getTime();
      const dayEnd = new Date(ty, tm - 1, td + 1, 0, 0, 0, 0).getTime();
      const pendingInDay = store.listSessions({
        since: dayStart,
        until: dayEnd,
        analysisStatus: "pending",
        limit: 500
      });
      if (pendingInDay.length > 0) {
        // 进度回显到 stderr，供菜单栏/终端实时感知
        console.error(`PROGRESS 正在补齐 ${pendingInDay.length} 个未分析会话…`);
        const analyzer = new ActivityAnalyzer(store, defaultConfig);
        let done = 0;
        while (done < pendingInDay.length) {
          const res = await analyzer.runOnce({ limit: 20 });
          if (res.processed === 0) break;
          done += res.processed;
          console.error(`PROGRESS 分析进度 ${Math.min(done, pendingInDay.length)}/${pendingInDay.length}`);
        }
      }

      console.error(`PROGRESS 正在生成报告…`);
      const renderer = new ReportRenderer(store, defaultConfig);
      const { outputPath } = await renderer.renderHtmlReport(dateKey, { force });
      console.log(`[Otus] HTML Report generated: ${outputPath}`);
      try {
        execSync(`open "${outputPath}"`);
      } catch {}
      console.error(`PROGRESS 完成`);
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

    case "config": {
      const sub = args[1];
      if (sub === "set") {
        const key = args[2];
        const val = args[3];
        if (!key || val === undefined) {
          console.log(`
Usage: otus config set <key> <value>

Supported keys:
  url, llmApiBase          Unified LLM API base URL (e.g. https://api.openai.com/v1)
  key, llmApiKey           Unified LLM API Key
  analysis, analysisModel  Fast model for session analysis (e.g. gpt-4o-mini, deepseek-chat)
  report, reportModel      Reasoning model for daily summary (e.g. gpt-4o, claude-3-7-sonnet)
  reporturl, reportApiBase Optional independent API URL for report model
  reportkey, reportApiKey  Optional independent API Key for report model
          `);
          return;
        }

        const keyMap: Record<string, keyof OtusConfig> = {
          url: "llmApiBase",
          llmapibase: "llmApiBase",
          key: "llmApiKey",
          llmapikey: "llmApiKey",
          analysis: "analysisModel",
          analysismodel: "analysisModel",
          report: "reportModel",
          reportmodel: "reportModel",
          reporturl: "reportApiBase",
          reportapibase: "reportApiBase",
          reportkey: "reportApiKey",
          reportapikey: "reportApiKey",
          analysisurl: "analysisApiBase",
          analysisapibase: "analysisApiBase",
          analysiskey: "analysisApiKey",
          analysisapikey: "analysisApiKey"
        };

        const targetKey = keyMap[key.toLowerCase()] || (key as keyof OtusConfig);
        saveUserConfig({ [targetKey]: val });
        console.log(`[Otus] Updated ${targetKey} = "${val}" in ${CONFIG_FILE}`);
        console.log(`[Otus] Note: If daemon is running, restart it to apply changes (otus stop && otus daemon).`);
        return;
      }

      const conf = getEffectiveConfig();
      console.log(`
=========================================
 Otus Configuration (${CONFIG_FILE})
=========================================
Unified API Base:  ${conf.llmApiBase}
Unified API Key:   ${conf.llmApiKey ? conf.llmApiKey.slice(0, 4) + "..." + conf.llmApiKey.slice(-4) : "(not set)"}
Analysis Model:    ${conf.analysisModel} ${conf.analysisApiBase ? `(Custom: ${conf.analysisApiBase})` : ""}
Report Model:      ${conf.reportModel} ${conf.reportApiBase ? `(Custom: ${conf.reportApiBase})` : ""}
Storage Limit:     ${(conf.maxStorageBytes / (1024 * 1024 * 1024)).toFixed(1)} GB
Snapshot Quality:  ${conf.snapshotQuality}% (max width: ${conf.snapshotMaxWidth}px)
=========================================

Quick Setup Examples:
  # 1. 使用 DeepSeek:
  otus config set url https://api.deepseek.com/v1
  otus config set key sk-your-key
  otus config set analysis deepseek-chat
  otus config set report deepseek-chat

  # 2. 使用本地完全离线 Ollama:
  otus config set url http://127.0.0.1:11434/v1
  otus config set key ollama
  otus config set analysis qwen2.5:7b
  otus config set report qwen2.5:14b

  # 3. 使用标准 OpenAI:
  otus config set url https://api.openai.com/v1
  otus config set key sk-proj-xxx
  otus config set analysis gpt-4o-mini
  otus config set report gpt-4o
      `);
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
  config              View or set LLM gateway, API keys, and models
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
