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

  // 浏览器访问三元组去重：app + url + title 均未变化时不重复记录
  private lastBrowserVisit: { app: string; url: string; title: string } | null = null;

  // 截屏并发锁：防止慢速截屏期间重复进入
  private captureInFlight: boolean = false;

  // 浏览器轮询连续失败计数，达到阈值后自禁用该 App 的轮询
  private browserPollFailures: Map<string, number> = new Map();
  private browserPollDisabled: Set<string> = new Set();

  // OCR 降频：每 N 张快照才执行一次识别
  private snapshotsSinceLastOcr: number = 0;

  // 闲置降频：连续跳过的次数
  private visualIdleTicks: number = 0;

  // 方案 B：最后一次检测到「画面实质变化」的时间戳（用于长任务活跃判定）
  private lastVisualActivityAt: number = 0;

  // 截屏失败退避：连续失败时指数延长重试间隔，避免 screencapture 报错刷屏
  private captureFailures: number = 0;
  private captureNextAllowedAt: number = 0;

  // Swift Helper Processes
  private inputMonitorProc: ChildProcess | null = null;
  private browserTabProc: ChildProcess | null = null;
  private inputBuffer: string = "";
  private browserBuffer: string = "";

  private ocrBinPath: string = "";
  private inputMonitorBinPath: string = "";
  private browserTabBinPath: string = "";
  private imgDiffBinPath: string = "";
  private windowTitleBinPath: string = "";

  // 窗口标题辅助进程（AXTitle）：按需请求，不自己轮询
  private windowTitleProc: ChildProcess | null = null;
  private windowTitleBuffer: string = "";
  private windowTitleResolvers: Array<(v: { ok: boolean; title?: string; bundleId?: string; error?: string }) => void> = [];
  // AX 权限缺失/连续失败时的退避：避免每次截图都白跑一次 IPC。
  // 按 bundleId 分桶：一个卡死 App 的超时不应把其它 App 的标题请求一起拖入长退避。
  private windowTitleFailures: number = 0; // 全局（保留：仅用于辅助功能整体失败）
  private windowTitleNextAllowedAt: number = 0; // 全局（保留：写失败等进程级故障）
  private windowTitleFailuresByApp: Map<string, number> = new Map();
  private windowTitleNextAllowedByApp: Map<string, number> = new Map();
  // 最近一次成功取到的窗口标题（供插入快照时使用）
  private lastWindowTitle: string | null = null;
  private windowTitleDisabled: boolean = false;
  // helper 崩溃/被 kill 后的自动重启（指数退避，封顶 30s）
  private windowTitleRestartTimer: NodeJS.Timeout | null = null;
  private windowTitleRestartFailures: number = 0;

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

    // 2.1 启动窗口标题辅助进程（AXTitle，按需请求，不轮询）
    this.startWindowTitleHelper();

    // 3. 启动常驻浏览器 AppleScript 通道
    this.startBrowserTabRunner();

    // 4. 定时心跳 (30s)
    this.heartbeatTimer = setInterval(() => {
      this.maybeCapture("heartbeat").catch((err) =>
        console.error("[ActivityRecorder] Heartbeat capture error:", err)
      );
    }, this.config.heartbeatIntervalMs);

    // 5. 定时画面差分检测
    // 闲置降频：长时间无输入时逐步降低检测频率（1x → 5x），避免空转采样
    if (this.config.visualCheckIntervalMs > 0) {
      this.visualTimer = setInterval(() => {
        const now = Date.now();
        if (now - this.lastCaptureAttemptAt < this.config.visualCheckIntervalMs) {
          this.visualIdleTicks = 0;
          return;
        }
        const idleMs = now - this.lastInputAt;
        if (idleMs > this.config.idleThresholdMs) {
          this.visualIdleTicks++;
          const skipEvery = Math.min(5, 1 + Math.floor(idleMs / (4 * this.config.visualCheckIntervalMs)));
          if (this.visualIdleTicks % skipEvery !== 0) return;
        } else {
          this.visualIdleTicks = 0;
        }
        this.maybeCapture("visual_change", { dedupOnly: true }).catch((err) =>
          console.error("[ActivityRecorder] Visual change capture error:", err)
        );
      }, this.config.visualCheckIntervalMs);
    }

    // 6. 浏览器活动轮询
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
    this.stopWindowTitleHelper();

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
      // 长任务活跃判定：即便无输入（人不操作），只要"任务在跑"——近期画面有实质变化，
      // 或前台是任务型 App——就不关闭会话，顺延一个 idle 周期继续累积。
      if (this.isEffectivelyActive()) {
        this.resetIdleTimer();
        return;
      }
      this.closeCurrentSession("idle");
    }, this.config.idleThresholdMs);
  }

  /**
   * 是否处于"有效活跃"状态（长任务 = 活跃）。
   * 三源任一成立即活跃：
   *   C. 真实输入：距上次输入 < idleThresholdMs
   *   B. 画面实质变化：距上次变化 < visualActivityWindowMs
   *   A. 前台任务型 App：当前前台命中白名单
   * 锁屏/合盖一律不算（由调用方保证 screenLocked 已拦截）。
   */
  private isEffectivelyActive(): boolean {
    if (this.screenLocked) return false;
    const now = Date.now();
    // C. 真实输入
    if (now - this.lastInputAt < this.config.idleThresholdMs) return true;
    // B. 画面实质变化
    if (this.lastVisualActivityAt > 0 && now - this.lastVisualActivityAt < this.config.visualActivityWindowMs) {
      return true;
    }
    // A. 前台任务型 App（持续存在即算，覆盖"AI 输出文字但不操作"场景）
    if (this.isTaskApp(this.frontmost.appName)) return true;
    return false;
  }

  /** 前台 App 是否属于任务型白名单（大小写不敏感的子串匹配，同时看 appName 与 bundleId） */
  private isTaskApp(appName: string, bundleId?: string): boolean {
    if (!this.config.taskAppWhitelist || this.config.taskAppWhitelist.length === 0) return false;
    const name = (appName || "").toLowerCase();
    const bid = (bundleId || this.frontmost.bundleId || "").toLowerCase();
    return this.config.taskAppWhitelist.some((token) => {
      const t = token.toLowerCase();
      return (name && name.includes(t)) || (bid && bid.includes(t));
    });
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
    // 窗口标题二进制：必须放在一个最小 .app bundle 内部。
    // 原因（macOS 实测）：裸的 adhoc 命令行二进制，即使被用户手动加入「辅助功能」，
    // 也常因 Gatekeeper / TCC 的 bundle 身份识别不稳定而拿不到 AX 权限，甚至被
    // AppleSystemPolicy 直接 SIGKILL。把它装进一个带 Info.plist 的最小 .app 后，
    // .app 的 bundle 身份让用户能在辅助功能面板里正常授权，且 AX 调用稳定生效。
    const windowTitleApp = path.join(this.config.binDir, "OtusWindowTitle.app");
    this.windowTitleBinPath = path.join(windowTitleApp, "Contents", "MacOS", "OtusWindowTitle");

    const compile = (srcName: string, outBin: string) => {
      const srcPath = path.join(nativeDir, srcName);
      if (!fs.existsSync(outBin) || fs.statSync(srcPath).mtimeMs > fs.statSync(outBin).mtimeMs) {
        console.log(`[ActivityRecorder] Compiling ${srcName} -> ${outBin}...`);
        execSync(`swiftc -O "${srcPath}" -o "${outBin}"`, { stdio: "inherit" });
        // Gatekeeper 修复：swiftc 产出的 adhoc 二进制若带 com.apple.provenance
        // 扩展属性，会被 AppleSystemPolicy 在内核层直接 SIGKILL（"load code signature
        // error 2" / "Security policy would not allow process"）。清掉 provenance 并
        // 显式 adhoc 重签名后即可正常执行。此问题只在一部分文件/目录上偶发，
        // 故对所有辅助二进制统一处理，保证构建确定性。
        try {
          execSync(`xattr -c "${outBin}" 2>/dev/null || true`, { stdio: "ignore" });
          execSync(`codesign --force -s - "${outBin}" 2>/dev/null || true`, { stdio: "ignore" });
        } catch {
          // 非致命：即使重签名失败，多数情况下二进制仍可运行
        }
      }
    };

    compile("ocr.swift", this.ocrBinPath);
    compile("input-monitor.swift", this.inputMonitorBinPath);
    compile("browser-tab.swift", this.browserTabBinPath);
    compile("img-diff.swift", this.imgDiffBinPath);

    // 构建 window-title 的 .app bundle：先 compile 到 app 内 MacOS 路径，再补 Info.plist 并签名整个 bundle。
    const wtSrc = path.join(nativeDir, "window-title.swift");
    const wtPlistPath = path.join(windowTitleApp, "Contents", "Info.plist");
    const wtBaseNeedsBuild =
      !fs.existsSync(this.windowTitleBinPath) ||
      !fs.existsSync(wtPlistPath) ||
      fs.statSync(wtSrc).mtimeMs > fs.statSync(this.windowTitleBinPath).mtimeMs;
    // 源码未变但 bundle 签名被外部破坏 / xattr 丢失 / 二进制被替换时，
    // 上面三项都察觉不到——用 codesign --verify 补一次完整性校验，失败则强制重建重签。
    let wtNeedsBuild = wtBaseNeedsBuild;
    if (!wtNeedsBuild) {
      try {
        execSync(`codesign --verify "${windowTitleApp}"`, { stdio: "ignore" });
      } catch {
        console.warn("[ActivityRecorder] window-title.app 签名校验未通过，将重建并重签...");
        wtNeedsBuild = true;
      }
    }
    if (wtNeedsBuild) {
      console.log(`[ActivityRecorder] Building window-title.app -> ${windowTitleApp}...`);
      fs.mkdirSync(path.join(windowTitleApp, "Contents", "MacOS"), { recursive: true });
      execSync(`swiftc -O "${wtSrc}" -o "${this.windowTitleBinPath}"`, { stdio: "inherit" });
      fs.writeFileSync(
        wtPlistPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>OtusWindowTitle</string>
    <key>CFBundleIdentifier</key><string>com.davidlin.otus.window-title</string>
    <key>CFBundleName</key><string>OtusWindowTitle</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSBackgroundOnly</key><true/>
    <key>LSUIElement</key><true/>
    <key>NSSupportsAutomaticTermination</key><true/>
    <key>NSSupportsSuddenTermination</key><true/>
</dict>
</plist>
`
      );
      try {
        execSync(`xattr -cr "${windowTitleApp}" 2>/dev/null || true`, { stdio: "ignore" });
        execSync(`codesign --force --deep -s - "${windowTitleApp}" 2>/dev/null || true`, { stdio: "ignore" });
      } catch {
        // 非致命
      }
    }
  }

  /**
   * 启动「窗口标题」辅助进程（长驻，按需请求 AXTitle）。
   * 失败（无辅助功能权限 / 二进制缺失）时不让整个 daemon 崩溃，
   * 只是把 windowTitleDisabled 置真，后续快照的 windowTitle 留空。
   */
  private startWindowTitleHelper(): void {
    if (this.windowTitleDisabled) return;
    if (!fs.existsSync(this.windowTitleBinPath)) return;
    try {
      const proc = spawn(this.windowTitleBinPath, [], { stdio: ["pipe", "pipe", "pipe"] });
      this.windowTitleProc = proc;
      this.windowTitleBuffer = "";
      this.windowTitleResolvers = [];
      // 新进程起来后清零重启失败计数（连续多次崩溃才持续退避）
      this.windowTitleRestartFailures = 0;

      proc.stdout?.on("data", (chunk: Buffer) => {
        this.windowTitleBuffer += chunk.toString("utf-8");
        const lines = this.windowTitleBuffer.split("\n");
        this.windowTitleBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // 一个回复对应一个等待中的 resolver
          const resolve = this.windowTitleResolvers.shift();
          if (!resolve) continue;
          try {
            resolve(JSON.parse(trimmed));
          } catch {
            resolve({ ok: false, error: "bad_json" });
          }
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        const msg = chunk.toString("utf-8").trim();
        if (msg) console.error("[ActivityRecorder:WindowTitle stderr]", msg);
      });

      proc.on("exit", (code) => {
        this.windowTitleProc = null;
        // 退出时把所有挂起的请求以失败结算，避免 await 永远挂着
        const pending = this.windowTitleResolvers;
        this.windowTitleResolvers = [];
        for (const r of pending) r({ ok: false, error: "helper_exited" });
        // 运行中且被非预期终止（kill -9 / 崩溃 / 内存回收）→ 退避自动重拉，
        // 否则 windowTitle 会永久为 null 直到手动重启 daemon。
        // 正常 stop() 发 SIGTERM 时 code 为 null 且 isRunning 已置 false，不触发重拉。
        if (this.isRunning && !this.windowTitleDisabled) {
          if (code !== 0 && code !== null) {
            console.warn(
              `[ActivityRecorder] 窗口标题辅助进程异常退出 (code=${code})，将退避重启。` +
              `若持续失败，请在「系统设置 → 隐私与安全性 → 辅助功能」授权：` +
              `${path.join(this.config.binDir, "OtusWindowTitle.app")}`
            );
          }
          this.scheduleWindowTitleRestart();
        }
      });
    } catch (err) {
      console.error("[ActivityRecorder] 启动窗口标题辅助进程失败：", err);
      this.windowTitleDisabled = true;
    }
  }

  private stopWindowTitleHelper(): void {
    if (this.windowTitleRestartTimer) {
      clearTimeout(this.windowTitleRestartTimer);
      this.windowTitleRestartTimer = null;
    }
    if (this.windowTitleProc) {
      try { this.windowTitleProc.kill("SIGTERM"); } catch {}
      this.windowTitleProc = null;
    }
    const pending = this.windowTitleResolvers;
    this.windowTitleResolvers = [];
    for (const r of pending) r({ ok: false, error: "stopped" });
  }

  // helper 崩溃后被 kill -9 也会走 exit(code=null)，用 isRunning 区分正常 stop。
  // 指数退避封顶 30s，连续崩溃不会无限拉长。
  private scheduleWindowTitleRestart(): void {
    if (this.windowTitleRestartTimer) return; // 已有待执行的重启
    this.windowTitleRestartFailures = Math.min(this.windowTitleRestartFailures + 1, 16);
    const delay = Math.min(30000, 500 * Math.pow(2, this.windowTitleRestartFailures - 1));
    this.windowTitleRestartTimer = setTimeout(() => {
      this.windowTitleRestartTimer = null;
      if (!this.isRunning || this.windowTitleDisabled) return;
      this.startWindowTitleHelper();
    }, delay);
  }

  /**
   * 请求指定 App 的焦点窗口标题。带超时与退避：
   *   - 按 bundleId 分桶退避（2s 起，封顶 60s）：一个卡死 App 不拖垮其它 App；
   *     app_not_running / no_window 等确定性失败不计入退避
   *   - 超时 800ms（AX 跨进程调用正常情况下 <10ms，超时说明目标 App 卡死）
   * 返回 null 表示取不到（无权限、无窗口、App 已退出、超时、退避中、bundleId 不匹配）。
   */
  private async requestWindowTitle(bundleId: string): Promise<string | null> {
    if (this.windowTitleDisabled || !this.windowTitleProc) return null;
    // 全局退避（进程级故障，如 stdin 写失败）与按 App 退避取较晚者
    const appNext = this.windowTitleNextAllowedByApp.get(bundleId) ?? 0;
    if (Date.now() < Math.max(this.windowTitleNextAllowedAt, appNext)) return null;

    return new Promise<string | null>((resolve) => {
      let settled = false;
      const done = (v: string | null) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };

      const timer = setTimeout(() => {
        // 超时：认为该 App 的 AX 响应异常，累计该 App 失败并退避
        this.onWindowTitleFailure(bundleId, "timeout");
        done(null);
      }, this.config.windowTitleTimeoutMs);

      this.windowTitleResolvers.push((resp) => {
        clearTimeout(timer);
        if (resp.ok) {
          this.windowTitleFailures = 0;
          this.windowTitleNextAllowedAt = 0;
          this.windowTitleFailuresByApp.delete(bundleId);
          this.windowTitleNextAllowedByApp.delete(bundleId);
          // 双保险：即使 helper 侧已做精确匹配，这里再校验返回的 bundleId 与请求一致，
          // 防止极端情况下（App 刚退出、bundleId 变更）把别的 App 的标题写进本快照。
          if (resp.bundleId && resp.bundleId !== bundleId) {
            done(null);
            return;
          }
          const title = (resp.title ?? "").trim();
          done(title || null);
        } else {
          // accessibility_not_granted 是"确定性"错误：直接长退避并只提示一次
          if (resp.error === "accessibility_not_granted") {
            this.windowTitleDisabled = true;
            console.warn(
              "[ActivityRecorder] 未获得辅助功能权限，窗口标题将留空。" +
              "如需补全，请在「系统设置 → 隐私与安全性 → 辅助功能」中授权这个 .app：" +
              path.join(this.config.binDir, "OtusWindowTitle.app")
            );
          } else if (resp.error === "app_not_running" || resp.error === "no_window") {
            // 确定性失败：App 无窗口 / 已退出。不计入退避，避免拖垮同批其它 App。
            done(null);
            return;
          } else {
            this.onWindowTitleFailure(bundleId, resp.error ?? "unknown");
          }
          done(null);
        }
      });

      try {
        this.windowTitleProc!.stdin?.write(JSON.stringify({ bundleId }) + "\n");
      } catch (e) {
        clearTimeout(timer);
        this.onWindowTitleFailure(bundleId, "write_failed");
        done(null);
      }
    });
  }

  private onWindowTitleFailure(bundleId: string, reason: string): void {
    const maxFailures = this.config.windowTitleMaxFailures;
    const backoffBase = this.config.windowTitleBackoffBaseMs;
    const backoffMax = this.config.windowTitleBackoffMaxMs;
    // write_failed 属进程级故障：走全局退避
    if (reason === "write_failed") {
      this.windowTitleFailures = Math.min(this.windowTitleFailures + 1, maxFailures);
      const backoff = Math.min(backoffMax, backoffBase * Math.pow(2, Math.max(0, this.windowTitleFailures - 1)));
      this.windowTitleNextAllowedAt = Date.now() + backoff;
      if (this.windowTitleFailures <= 3) {
        console.warn(`[ActivityRecorder] 取窗口标题失败(${this.windowTitleFailures}/${maxFailures}, ${reason})，${backoff}ms 后重试`);
      }
      return;
    }
    // 按 App 分桶退避：base * 2^(n-1)，封顶 max
    const n = Math.min((this.windowTitleFailuresByApp.get(bundleId) ?? 0) + 1, maxFailures);
    this.windowTitleFailuresByApp.set(bundleId, n);
    const backoff = Math.min(backoffMax, backoffBase * Math.pow(2, Math.max(0, n - 1)));
    this.windowTitleNextAllowedByApp.set(bundleId, Date.now() + backoff);
    if (n <= 3) {
      console.warn(`[ActivityRecorder] 取窗口标题失败(${bundleId} ${n}/16, ${reason})，${backoff}ms 后重试`);
    }
  }

  // 输入监听
  private startInputMonitor(): void {
    if (!fs.existsSync(this.inputMonitorBinPath)) return;
    console.log("[ActivityRecorder] Spawning input monitor process...");

    const proc = spawn(this.inputMonitorBinPath, [String(this.config.focusPollIntervalMs)], { stdio: ["ignore", "pipe", "pipe"] });
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

    // 方案 A：轮询来的 app_focus 只补归属，不刷新"输入活跃"时间戳。
    // 真实用户焦点切换（无 via 或 via!=="poll"）才算输入活跃。
    const isPollFocus = type === "app_focus" && ev.via === "poll";
    if (!isPollFocus) {
      this.lastInputAt = ts;
    }

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
        data: { bundleId: this.frontmost.bundleId, via: isPollFocus ? "poll" : "event" }
      });
      // 轮询焦点不是真实输入，不触发抓拍；真实切换才抓拍
      if (!isPollFocus) this.scheduleCapture("app_focus");
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
    // 并发锁：screencapture 同步阻塞期间不允许重入
    if (this.captureInFlight) return;
    // 失败退避：连续失败时按指数拉长重试间隔（500ms 起，封顶 30s）
    if (Date.now() < this.captureNextAllowedAt) return;
    // 防抖：距上次尝试不足 snapshotDebounceMs 时跳过（心跳周期由定时器保证，不受此限）
    if (trigger !== "heartbeat" && Date.now() - this.lastCaptureAttemptAt < this.config.snapshotDebounceMs) return;

    this.captureInFlight = true;
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

      // 1.1 压缩策略：macOS 原生 sips 等比缩放至最大 2560 宽、质量 55（对齐 Alma）。
      // Alma: max_width=2560, quality=jpegQuality/100=0.55 → 落盘约 300KB/张。
      // 降到 1280/40 会让 12px 系统字号缩到 6px，OCR 对中文小字识别率明显下降，
      // 视觉模型也读不清界面正文。判重走独立的 160×90 内存缩略图，不受此值影响。
      try {
        execSync(
          `sips -Z ${this.config.snapshotMaxWidth} -s formatOptions ${this.config.snapshotQuality} "${tmpPath}" --out "${tmpPath}"`,
          { stdio: "ignore", timeout: 3000 }
        );
      } catch {}

      const stat = fs.statSync(tmpPath);
      if (stat.size === 0) {
        fs.unlinkSync(tmpPath);
        return;
      }

      // 2. 图像哈希判重 (避免连续多张一模一样的静止帧)
      // 心跳抓拍豁免：即使画面完全静止也保留快照，确保心跳会话不会退化为 0 快照空壳
      const isHeartbeat = trigger === "heartbeat";
      const fileBuf = fs.readFileSync(tmpPath);
      const hashHex = crypto.createHash("md5").update(fileBuf).digest("hex");
      if (!isHeartbeat && this.prevHashHex === hashHex) {
        fs.unlinkSync(tmpPath);
        return;
      }

      // 2.1 原生三级图像差分过滤（对齐 Alma 的 isDuplicate 实现）
      //   ① 32-bin 归一化灰度直方图 + 巴氏距离：捕捉整体亮度分布变化
      //   ② 像素级容差比对（160x90 缩略图）：过滤光标闪烁、时钟跳秒、抗锯齿抖动等局部微变
      // 只有两级都判定为「变化」时才保留快照，同样豁免心跳触发
      if (
        !isHeartbeat &&
        this.prevSnapshotPath &&
        fs.existsSync(this.prevSnapshotPath) &&
        fs.existsSync(this.imgDiffBinPath)
      ) {
        try {
          // otus-diff 退出码 0 代表画面高度相似 (duplicate)，退出码 1 代表有显著画面变化 (changed)
          execSync(
            `"${this.imgDiffBinPath}" "${this.prevSnapshotPath}" "${tmpPath}" ` +
              `${this.config.histogramChangeThreshold} ${this.config.pixelDiffThreshold} ${this.config.pixelTolerance}`,
            { stdio: "pipe" }
          );
          fs.unlinkSync(tmpPath);
          return;
        } catch {
          // 退出码非 0 说明检测到实质画面变动，正常进入后续持久化与识别流程
          // 方案 B：记录"画面实质变化"时间，供长任务活跃判定使用
          this.lastVisualActivityAt = Date.now();
        }
      }

      this.prevHashHex = hashHex;

      // 3. 移至永久快照目录
      const finalFileName = `${Date.now()}_${trigger}.jpg`;
      const finalPath = path.join(dateDir, finalFileName);
      fs.renameSync(tmpPath, finalPath);
      this.prevSnapshotPath = finalPath;

      // 3.5 取窗口标题（AXTitle，仅非浏览器 App；浏览器已通过 AppleScript 拿标题）。
      //     失败/无权限时为 null，不影响快照入库。请求被去抖到与截图同频，非轮询。
      //
      // ⚠️ 关键：此处先把 frontmost 快照到局部变量再 await。
      //     requestWindowTitle 最长 await 800ms，期间 input-monitor 的 app_focus 事件
      //     会改写 this.frontmost；若 await 后再读 this.frontmost 写 appName/title，
      //     会出现「快照 appName 是 A、windowTitle 是 B」的张冠李戴（实测已复现）。
      const frontmostSnap = { bundleId: this.frontmost.bundleId, appName: this.frontmost.appName };
      let windowTitle: string | null = null;
      // 空 appName（daemon 刚启动、尚未收到首条 app_focus）时不发 AX 请求：
      //   既省一次 IPC，也避免空 bundleId 在 helper 侧回退到「当前前台」而拿到别的 App 标题。
      if (frontmostSnap.appName && !this.isBrowserAppName(frontmostSnap.appName)) {
        windowTitle = await this.requestWindowTitle(frontmostSnap.bundleId);
        // 标题入库前脱敏：窗口标题可能含文件路径/含密钥的编辑器标题等（与 OCR 路径一致）
        if (windowTitle) windowTitle = redactSensitiveText(windowTitle).redacted || null;
        if (windowTitle) this.lastWindowTitle = windowTitle;
      }

      // 4. 插入快照记录
      const snapId = this.store.insertSnapshot(session.id, {
        timestamp: Date.now(),
        filePath: finalPath,
        sizeBytes: stat.size,
        trigger,
        appName: frontmostSnap.appName,
        windowTitle,
        hashHex
      });

      // 4.1 同步写一条 window_title 事件（非浏览器 App），供分析与报告层读取窗口上下文。
      //     与浏览器路径的 window_title 事件（source=browser）互补，这里 source=ax。
      if (windowTitle) {
        this.store.insertEvent(session.id, {
          timestamp: Date.now(),
          kind: "window_title",
          appName: frontmostSnap.appName,
          data: { title: windowTitle, source: "ax" }
        });
      }

      // 5. OCR 降频：每 ocrEveryN 张才识别一次，降低 Apple Vision 开销
      this.snapshotsSinceLastOcr++;
      const ocrEveryN = Math.max(1, this.config.ocrEveryN || 1);
      if (ocrEveryN === 1 || this.snapshotsSinceLastOcr >= ocrEveryN) {
        this.snapshotsSinceLastOcr = 0;
        this.runOcr(snapId, session.id, finalPath);
      }

      // 成功一次即清零退避
      if (this.captureFailures > 0) {
        console.log(`[ActivityRecorder] 截图恢复正常（此前连续失败 ${this.captureFailures} 次）`);
      }
      this.captureFailures = 0;
      this.captureNextAllowedAt = 0;
    } catch (err) {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      // 指数退避：500ms * 2^(n-1)，封顶 30s，最多累计 16 次
      this.captureFailures = Math.min(this.captureFailures + 1, 16);
      const backoffMs = Math.min(30000, 500 * Math.pow(2, this.captureFailures - 1));
      this.captureNextAllowedAt = Date.now() + backoffMs;
      // 前 3 次打印完整错误，之后降噪为单行摘要
      if (this.captureFailures <= 3) {
        console.error(
          `[ActivityRecorder] screencapture failed (${this.captureFailures}/16)，${backoffMs}ms 后重试：`,
          err
        );
      } else if (this.captureFailures === 4) {
        console.error(
          `[ActivityRecorder] 截图持续失败，已进入退避模式（后续仅每 16 次失败时提示一次）。`
        );
      } else if (this.captureFailures % 16 === 0) {
        console.error(`[ActivityRecorder] 截图仍失败（累计 ${this.captureFailures} 次）。`);
      }
    } finally {
      this.captureInFlight = false;
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

  private isBrowserFrontmost(): boolean {
    return this.isBrowserAppName(this.frontmost.appName);
  }

  // 判断给定 App 名是否属于浏览器（纯函数：不读 this.frontmost，供快照后判断用）。
  private isBrowserAppName(appName: string): boolean {
    const browserNames = ["Google Chrome", "Safari", "Arc", "Brave Browser", "Microsoft Edge", "Firefox"];
    return browserNames.some((b) => appName.toLowerCase().includes(b.toLowerCase()));
  }

  private async pollBrowserVisit(): Promise<void> {
    if (!this.currentSession || !this.frontmost.appName) return;
    if (!this.isBrowserFrontmost()) {
      return;
    }
    // 该浏览器已因连续失败被停用
    if (this.browserPollDisabled.has(this.frontmost.appName)) return;

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

      // 轮询成功，清零失败计数
      this.browserPollFailures.delete(this.frontmost.appName);

      if (out && out.includes("|||")) {
        const [url, title] = out.split("|||");
        if (url && url.startsWith("http")) {
          const app = this.frontmost.appName;
          const cleanUrl = url.trim();
          const cleanTitle = (title || "").trim();

          // 三元组去重：同一 App 的同一 URL + 同一标题视为持续停留，不重复记录
          const last = this.lastBrowserVisit;
          if (last && last.app === app && last.url === cleanUrl && last.title === cleanTitle) {
            return;
          }
          this.lastBrowserVisit = { app, url: cleanUrl, title: cleanTitle };

          const now = Date.now();
          this.store.insertEvent(this.currentSession.id, {
            timestamp: now,
            kind: "browser_visit",
            appName: app,
            data: { url: cleanUrl, title: cleanTitle }
          });

          // 同步记录窗口标题，便于后续分析获取窗口上下文
          if (cleanTitle) {
            this.store.insertEvent(this.currentSession.id, {
              timestamp: now,
              kind: "window_title",
              appName: app,
              data: { title: cleanTitle, source: "browser" }
            });
          }
        }
      }
    } catch (err: any) {
      // 连续失败 3 次的 App 自禁用轮询，避免反复报错刷屏（如浏览器未启动或权限缺失）
      const app = this.frontmost.appName;
      const failures = (this.browserPollFailures.get(app) ?? 0) + 1;
      this.browserPollFailures.set(app, failures);
      if (failures >= 3) {
        this.browserPollDisabled.add(app);
        console.warn(
          `[ActivityRecorder] 浏览器轮询已对 ${app} 停用（连续失败 ${failures} 次）：${String(err?.message || err).slice(0, 160)}`
        );
      }
    }
  }
}
