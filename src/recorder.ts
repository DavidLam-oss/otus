import { spawn, execSync, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ActivityStore } from "./store.ts";
import type { ActivitySession } from "./store.ts";
import { defaultConfig, getLocalDateKey } from "./config.ts";
import type { OtusConfig } from "./config.ts";
import { redactSensitiveText } from "./redactor.ts";

interface FrontmostApp {
  bundleId: string;
  appName: string;
}

export class ActivityRecorderService {
  private store: ActivityStore;
  private config: OtusConfig;
  private isRunning: boolean = false;

  private currentSession: ActivitySession | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private visualTimer: NodeJS.Timeout | null = null;
  private browserPollTimer: NodeJS.Timeout | null = null;

  private pendingCaptureTimer: NodeJS.Timeout | null = null;
  private pendingCaptureTrigger: string | null = null;
  private typingPauseTimer: NodeJS.Timeout | null = null;
  private lastCaptureAttemptAt: number = 0;
  private lastInputAt: number = 0;
  private lastSensitiveEventAt: number = 0;
  private screenLocked: boolean = false;

  private frontmost: FrontmostApp = { bundleId: "", appName: "" };
  private prevHashHex: string | null = null;
  private prevSnapshotPath: string | null = null;

  // Swift Helper Processes
  private inputMonitorProc: ChildProcess | null = null;
  private browserTabProc: ChildProcess | null = null;
  private inputBuffer: string = "";
  private browserBuffer: string = "";

  private ocrBinPath: string = "";
  private inputMonitorBinPath: string = "";
  private browserTabBinPath: string = "";
  private imgDiffBinPath: string = "";

  public onSessionClosed?: (session: ActivitySession) => void;
  public onWake?: () => void;

  constructor(store: ActivityStore, config: Partial<OtusConfig> = {}) {
    this.store = store;
    this.config = { ...defaultConfig, ...config };
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log("[ActivityRecorder] Starting Otus recorder service...");

    fs.mkdirSync(this.config.outputDir, { recursive: true });
    fs.mkdirSync(this.config.snapshotsDir, { recursive: true });
    fs.mkdirSync(this.config.binDir, { recursive: true });
    fs.mkdirSync(this.config.tmpDir, { recursive: true });

    // 1. 确保 Swift 原生辅助二进制就绪
    await this.ensureSwiftBinaries();

    // 2. 启动全局输入与焦点监听
    if (this.config.enableInputMonitor) {
      this.startInputMonitor();
    }

    // 3. 启动常驻浏览器 AppleScript 通道
    this.startBrowserTabRunner();

    // 4. 定时心跳 (30s)
    this.heartbeatTimer = setInterval(() => {
      this.maybeCapture("heartbeat").catch((err) =>
        console.error("[ActivityRecorder] Heartbeat capture error:", err)
      );
    }, this.config.heartbeatIntervalMs);

    // 5. 定时画面差分检测 (10s)
    if (this.config.visualCheckIntervalMs > 0) {
      this.visualTimer = setInterval(() => {
        const now = Date.now();
        if (now - this.lastCaptureAttemptAt >= this.config.visualCheckIntervalMs) {
          this.maybeCapture("visual_change", { dedupOnly: true }).catch((err) =>
            console.error("[ActivityRecorder] Visual change capture error:", err)
          );
        }
      }, this.config.visualCheckIntervalMs);
    }

    // 6. 浏览器活动轮询 (5s)
    if (this.config.browserPollIntervalMs > 0) {
      this.browserPollTimer = setInterval(() => {
        this.pollBrowserVisit().catch((err) =>
          console.error("[ActivityRecorder] Browser poll error:", err)
        );
      }, this.config.browserPollIntervalMs);
    }

    // 清理未正常退出的孤立 open sessions
    for (const openSess of this.store.listOpenSessions()) {
      this.store.closeSession(openSess.id, Date.now());
    }

    console.log(
      `[ActivityRecorder] Running — debounce ${this.config.snapshotDebounceMs}ms, heartbeat ${this.config.heartbeatIntervalMs}ms, output: ${this.config.outputDir}`
    );
  }

  public stop(): void {
    if (!this.isRunning) return;
    console.log("[ActivityRecorder] Stopping recorder service...");
    this.isRunning = false;

    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.visualTimer) clearInterval(this.visualTimer);
    if (this.browserPollTimer) clearInterval(this.browserPollTimer);
    if (this.pendingCaptureTimer) clearTimeout(this.pendingCaptureTimer);
    if (this.typingPauseTimer) clearTimeout(this.typingPauseTimer);

    if (this.inputMonitorProc) {
      this.inputMonitorProc.kill("SIGTERM");
      this.inputMonitorProc = null;
    }
    if (this.browserTabProc) {
      this.browserTabProc.kill("SIGTERM");
      this.browserTabProc = null;
    }

    this.closeCurrentSession("shutdown");
  }

  public isUserActive(): boolean {
    return Date.now() - this.lastInputAt < this.config.idleThresholdMs;
  }

  // Session 生命周期
  public ensureSession(trigger: string = "idle"): ActivitySession {
    if (!this.currentSession) {
      this.currentSession = this.store.createSession({ triggerKind: trigger });
      this.resetIdleTimer();
    }
    return this.currentSession;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.closeCurrentSession("idle");
    }, this.config.idleThresholdMs);
  }

  public closeCurrentSession(reason: string): void {
    if (!this.currentSession) return;
    const sess = this.currentSession;
    this.currentSession = null;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    try {
      this.store.closeSession(sess.id);
      const updated = this.store.getSession(sess.id) ?? sess;
      console.log(
        `[ActivityRecorder] Session closed (${reason}): ${updated.id} duration=${Math.round((updated.durationMs || 0) / 1000)}s events=${updated.eventCount} snapshots=${updated.snapshotCount}`
      );
      if (this.onSessionClosed) {
        this.onSessionClosed(updated);
      }
    } catch (err) {
      console.error("[ActivityRecorder] closeSession error:", err);
    }
  }

  // Swift 编译助手
  private async ensureSwiftBinaries(): Promise<void> {
    fs.mkdirSync(this.config.binDir, { recursive: true });
    fs.mkdirSync(this.config.tmpDir, { recursive: true });
    fs.mkdirSync(this.config.snapshotsDir, { recursive: true });

    const nativeDir = path.resolve(import.meta.dirname, "../native");
    this.ocrBinPath = path.join(this.config.binDir, "otus-ocr");
    this.inputMonitorBinPath = path.join(this.config.binDir, "otus-input-monitor");
    this.browserTabBinPath = path.join(this.config.binDir, "otus-browser-tab");
    this.imgDiffBinPath = path.join(this.config.binDir, "otus-diff");

    const compile = (srcName: string, outBin: string) => {
      const srcPath = path.join(nativeDir, srcName);
      if (!fs.existsSync(outBin) || fs.statSync(srcPath).mtimeMs > fs.statSync(outBin).mtimeMs) {
        console.log(`[ActivityRecorder] Compiling ${srcName} -> ${outBin}...`);
        execSync(`swiftc -O "${srcPath}" -o "${outBin}"`, { stdio: "inherit" });
      }
    };

    compile("ocr.swift", this.ocrBinPath);
    compile("input-monitor.swift", this.inputMonitorBinPath);
    compile("browser-tab.swift", this.browserTabBinPath);
    compile("img-diff.swift", this.imgDiffBinPath);
  }

  // 输入监听
  private startInputMonitor(): void {
    if (!fs.existsSync(this.inputMonitorBinPath)) return;
    console.log("[ActivityRecorder] Spawning input monitor process...");

    const proc = spawn(this.inputMonitorBinPath, [], { stdio: ["ignore", "pipe", "pipe"] });
    this.inputMonitorProc = proc;

    proc.stdout?.on("data", (chunk: Buffer) => {
      this.inputBuffer += chunk.toString("utf-8");
      const lines = this.inputBuffer.split("\n");
      this.inputBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            this.handleInputLine(JSON.parse(trimmed));
          } catch {}
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString("utf-8").trim();
      if (msg) console.error("[ActivityRecorder:InputMonitor stderr]", msg);
    });

    proc.on("exit", (code) => {
      console.log(`[ActivityRecorder] Input monitor exited (${code})`);
      this.inputMonitorProc = null;
      if (this.isRunning && code !== 0) {
        console.warn(
          "[ActivityRecorder] Input monitor exited. Ensure Accessibility permission is granted in macOS System Settings."
        );
      }
    });
  }

  private handleInputLine(ev: any): void {
    if (!ev || typeof ev.type !== "string") return;
    const type = ev.type;
    const ts = typeof ev.timestamp === "number" ? ev.timestamp : Date.now();

    if (type === "lock" || type === "sleep" || type === "screens_sleep") {
      this.screenLocked = true;
      const s = this.ensureSession(type);
      this.store.insertEvent(s.id, { timestamp: ts, kind: type, appName: this.frontmost.appName });
      this.closeCurrentSession(type);
      return;
    }

    if (type === "unlock" || type === "wake" || type === "screens_wake") {
      this.screenLocked = false;
      this.prevHashHex = null;
      this.prevSnapshotPath = null;
      const s = this.ensureSession(type);
      this.store.insertEvent(s.id, { timestamp: ts, kind: type, appName: this.frontmost.appName });
      try {
        this.onWake?.();
      } catch (err) {
        console.error("[ActivityRecorder] onWake handler error:", err);
      }
      return;
    }

    if (ev.bundleId || ev.appName) {
      this.frontmost = {
        bundleId: ev.bundleId || this.frontmost.bundleId,
        appName: ev.appName || this.frontmost.appName
      };
    }

    if (this.screenLocked) return;

    // 敏感应用拦截
    if (this.isSensitiveAppFocused()) {
      if (ts - this.lastSensitiveEventAt >= 5000) {
        const s = this.ensureSession();
        this.store.insertEvent(s.id, {
          timestamp: ts,
          kind: "system",
          appName: this.frontmost.appName,
          data: { suppressed: true, reason: "sensitive_app" }
        });
        this.lastSensitiveEventAt = ts;
      }
      return;
    }

    const session = this.ensureSession();
    this.resetIdleTimer();
    this.lastInputAt = ts;

    if (type === "click") {
      this.store.insertEvent(session.id, {
        timestamp: ts,
        kind: "click",
        appName: this.frontmost.appName,
        data: { x: ev.x, y: ev.y, button: ev.button }
      });
      this.scheduleCapture("click");
    } else if (type === "keypress") {
      this.scheduleTypingPauseCapture();
    } else if (type === "app_focus") {
      this.prevHashHex = null;
      this.store.insertEvent(session.id, {
        timestamp: ts,
        kind: "app_focus",
        appName: this.frontmost.appName,
        data: { bundleId: this.frontmost.bundleId }
      });
      this.scheduleCapture("app_focus");
    }
  }

  private isSensitiveAppFocused(): boolean {
    return (
      !!this.frontmost.bundleId &&
      this.config.sensitiveApps.some((b) => this.frontmost.bundleId.toLowerCase().includes(b.toLowerCase()))
    );
  }

  private scheduleCapture(trigger: string): void {
    const elapsed = Date.now() - this.lastCaptureAttemptAt;
    if (elapsed >= this.config.snapshotDebounceMs) {
      this.maybeCapture(trigger).catch((err) =>
        console.error("[ActivityRecorder] Capture error:", err)
      );
      return;
    }

    this.pendingCaptureTrigger = trigger;
    if (!this.pendingCaptureTimer) {
      const wait = this.config.snapshotDebounceMs - elapsed;
      this.pendingCaptureTimer = setTimeout(() => {
        const t = this.pendingCaptureTrigger ?? trigger;
        this.pendingCaptureTimer = null;
        this.pendingCaptureTrigger = null;
        this.maybeCapture(t).catch((err) =>
          console.error("[ActivityRecorder] Delayed capture error:", err)
        );
      }, wait);
    }
  }

  private scheduleTypingPauseCapture(): void {
    if (this.typingPauseTimer) clearTimeout(this.typingPauseTimer);
    this.typingPauseTimer = setTimeout(() => {
      this.maybeCapture("typing_pause").catch((err) =>
        console.error("[ActivityRecorder] Typing pause capture error:", err)
      );
    }, this.config.typingPauseMs);
  }

  // 抓拍与 OCR 执行
  public async maybeCapture(trigger: string, opts: { dedupOnly?: boolean } = {}): Promise<void> {
    if (!this.isRunning || this.screenLocked || this.isSensitiveAppFocused()) return;

    this.lastCaptureAttemptAt = Date.now();
    const session = this.ensureSession(trigger);
    const dateKey = getLocalDateKey();
    const dateDir = path.join(this.config.snapshotsDir, dateKey);
    fs.mkdirSync(dateDir, { recursive: true });

    const tmpPath = path.join(this.config.tmpDir, `cap_${Date.now()}.jpg`);
    try {
      // 1. 系统原生静音截图
      execSync(`screencapture -x -C -t jpg "${tmpPath}"`, { stdio: "ignore" });
      if (!fs.existsSync(tmpPath)) return;

      // 1.1 压缩策略：macOS 原生 sips 极速等比缩放至最大 1280，质量 40 (单张体积从 5MB 骤降至 40~60KB，耗时 < 15ms)
      try {
        execSync(
          `sips -Z ${this.config.snapshotMaxWidth} -s formatOptions ${this.config.snapshotQuality} "${tmpPath}" --out "${tmpPath}"`,
          { stdio: "ignore", timeout: 2000 }
        );
      } catch {}

      const stat = fs.statSync(tmpPath);
      if (stat.size === 0) {
        fs.unlinkSync(tmpPath);
        return;
      }

      // 2. 图像哈希判重 (避免连续多张一模一样的静止帧)
      const fileBuf = fs.readFileSync(tmpPath);
      const hashHex = crypto.createHash("md5").update(fileBuf).digest("hex");
      if (this.prevHashHex === hashHex) {
        fs.unlinkSync(tmpPath);
        return;
      }

      // 2.1 原生直方图差分过滤 (32-bin 归一化灰度直方图 + 巴氏距离比对)
      // 若画面变动 < 5% (如右下角时钟跳动、输入框光标闪烁)，判定为重复静止帧直接丢弃，彻底消除冗余快照与无谓 OCR
      if (this.prevSnapshotPath && fs.existsSync(this.prevSnapshotPath) && fs.existsSync(this.imgDiffBinPath)) {
        try {
          // otus-diff 退出码 0 代表画面高度相似 (duplicate)，退出码 1 代表有显著画面变化 (changed)
          execSync(`"${this.imgDiffBinPath}" "${this.prevSnapshotPath}" "${tmpPath}" 0.05`, { stdio: "pipe" });
          fs.unlinkSync(tmpPath);
          return;
        } catch {
          // 退出码非 0 说明检测到实质画面变动，正常进入后续持久化与识别流程
        }
      }

      this.prevHashHex = hashHex;

      // 3. 移至永久快照目录
      const finalFileName = `${Date.now()}_${trigger}.jpg`;
      const finalPath = path.join(dateDir, finalFileName);
      fs.renameSync(tmpPath, finalPath);
      this.prevSnapshotPath = finalPath;

      // 4. 插入快照记录
      const snapId = this.store.insertSnapshot(session.id, {
        timestamp: Date.now(),
        filePath: finalPath,
        sizeBytes: stat.size,
        trigger,
        appName: this.frontmost.appName,
        hashHex
      });

      // 5. 调用 Apple Vision OCR (异步识别)
      this.runOcr(snapId, session.id, finalPath);
    } catch (err) {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      console.error("[ActivityRecorder] screencapture failed:", err);
    }
  }

  private runOcr(snapId: string, sessionId: string, imgPath: string): void {
    if (!fs.existsSync(this.ocrBinPath)) return;
    try {
      const langs = this.config.ocrLanguages.join(",");
      const rawText = execSync(`"${this.ocrBinPath}" "${imgPath}" "${langs}"`, {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024
      }).trim();

      if (rawText && rawText.length > 5) {
        // 原生 PII 脱敏 (自动识别并遮蔽私钥、各类 API Key、Token)
        const { redacted, hits } = redactSensitiveText(rawText);
        const hitCount = Object.values(hits).reduce((a, b) => a + b, 0);
        if (hitCount > 0) {
          console.log(`[ActivityRecorder] Redacted ${hitCount} sensitive token(s) from snapshot ${snapId}`);
        }
        this.store.insertOcrFrame(snapId, sessionId, redacted);
      }
    } catch (err) {
      console.error("[ActivityRecorder] OCR failed for snapshot:", snapId, err);
    }
  }

  // 浏览器穿透
  private startBrowserTabRunner(): void {
    if (!fs.existsSync(this.browserTabBinPath)) return;
    try {
      const proc = spawn(this.browserTabBinPath, [], { stdio: ["pipe", "pipe", "pipe"] });
      this.browserTabProc = proc;

      proc.on("exit", () => {
        this.browserTabProc = null;
      });
    } catch (err) {
      console.warn("[ActivityRecorder] Browser tab helper unavailable:", err);
    }
  }

  private async pollBrowserVisit(): Promise<void> {
    if (!this.currentSession || !this.frontmost.appName) return;
    const browserNames = ["Google Chrome", "Safari", "Arc", "Brave Browser", "Microsoft Edge", "Firefox"];
    if (!browserNames.some((b) => this.frontmost.appName.toLowerCase().includes(b.toLowerCase()))) {
      return;
    }

    const script = `
      tell application "${this.frontmost.appName}"
        if (count of windows) > 0 then
          set currentTab to active tab of front window
          return (URL of currentTab) & "|||" & (title of currentTab)
        end if
      end tell
    `;

    try {
      const out = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        encoding: "utf-8",
        timeout: 1000
      }).trim();

      if (out && out.includes("|||")) {
        const [url, title] = out.split("|||");
        if (url && url.startsWith("http")) {
          this.store.insertEvent(this.currentSession.id, {
            timestamp: Date.now(),
            kind: "browser_visit",
            appName: this.frontmost.appName,
            data: { url: url.trim(), title: (title || "").trim() }
          });
        }
      }
    } catch {}
  }
}
