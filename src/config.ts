import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const homeDir = os.homedir();
export const DATA_DIR = path.join(homeDir, ".otus");
export const CONFIG_FILE = path.join(DATA_DIR, "config.json");
export const DB_PATH = path.join(DATA_DIR, "data.db");
export const SNAPSHOTS_DIR = path.join(DATA_DIR, "snapshots");
export const BIN_DIR = path.join(DATA_DIR, "bin");
export const TMP_DIR = path.join(DATA_DIR, "tmp");

export function getLocalDateKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface OtusConfig {
  outputDir: string;
  dbPath: string;
  snapshotsDir: string;
  binDir: string;
  tmpDir: string;
  maxStorageBytes: number;
  targetStorageBytes: number;   // 容量兜底清理的目标水位

  // 三级生命周期保留期（对齐 Alma Vq）
  hotRetentionMs: number;
  warmRetentionMs: number;
  coldRetentionMs: number;

  // warm 层重压缩参数（7 天后）
  warmRecompressEnabled: boolean;
  warmRecompressMaxWidth: number;
  warmRecompressMaxHeight: number;
  warmRecompressQuality: number;

  // cold 层重压缩参数（30 天后）
  coldRecompressEnabled: boolean;
  coldRecompressMaxWidth: number;
  coldRecompressMaxHeight: number;
  coldRecompressQuality: number;

  enableInputMonitor: boolean;
  snapshotDebounceMs: number;
  typingPauseMs: number;
  idleThresholdMs: number;
  heartbeatIntervalMs: number;
  visualCheckIntervalMs: number;
  browserPollIntervalMs: number;

  // 长任务活动判定（"任务在跑 = 活跃"）
  focusPollIntervalMs: number;        // 前台 App 定期采样间隔（方案 A）
  visualActivityWindowMs: number;     // 画面实质变化后，多久内仍算活跃（方案 B）
  taskAppWhitelist: string[];         // 任务型 App 白名单（前台为此类且持续存在即算活跃）

  // 窗口标题（AXTitle）辅助进程参数
  windowTitleTimeoutMs: number;      // 单次 AX 请求超时（AX 跨进程正常 <10ms，超时说明目标 App 卡死）
  windowTitleBackoffBaseMs: number;  // 按 App 分桶退避的起始间隔
  windowTitleBackoffMaxMs: number;   // 退避上限
  windowTitleMaxFailures: number;    // 连续失败计数上限（指数退避的幂次封顶）

  sensitiveApps: string[];
  ocrLanguages: string[];
  ocrEveryN: number;

  // 分析前的相邻会话合并窗口（毫秒）：间隔小于该值且共享 App 的碎片会被合并
  mergeGapMs: number;
  // 可参与合并的短碎片时长上限：超过该时长的会话视为完整活动单元，不参与合并
  mergeMaxDurationMs: number;
  mergeMaxSpanMs: number;

  // HAC 聚类的切割距离（= 1 - 余弦相似度 + 时间惩罚）。越小越易并簇。
  clusterCutDistance: number;
  // 时间连续性惩罚权重 β（0 关闭；封顶 β，线性斜坡到饱和）
  clusterTimeBeta: number;
  // 时间惩罚衰减尺度 τ（毫秒）：间隔超过 τ 后惩罚饱和到 β
  clusterTimeTauMs: number;

  // 分析质量门槛：三项指标全部低于下限时才跳过 LLM（对齐 Alma）
  minSessionDurationMs: number;
  minSessionEventCount: number;
  minSessionSnapshotCount: number;

  // OCR 抽取参数
  ocrCharBudget: number;      // 单会话 OCR 文本总字符预算
  ocrDedupThreshold: number;  // 相邻文本相似度超过该值视为重复
  maxOcrFrames: number;       // 最多读取的 OCR 帧数

  // 截图压缩配置（对齐 Alma：2560 宽 + 质量 55）
  // 为什么从 1280/40 提到 2560/55：1280 宽下 12px 系统字号缩到 6px，
  // OCR 对中文小字识别率明显下降，视觉模型也读不清界面正文。
  // Alma 的 native shotDisplay 用 max_width=2560、quality=jpegQuality/100=0.55，
  // 实测 300 张均值约 250KB/张（随画面复杂度 48KB–643KB 波动）。判重仍走独立的 160×90 内存缩略图，不受此值影响。
  snapshotMaxWidth: number;
  snapshotQuality: number;

  // 三级图像判重参数（对齐 Alma）
  histogramChangeThreshold: number;
  pixelDiffThreshold: number;
  pixelTolerance: number;

  // LLM Config
  llmApiBase: string;
  llmApiKey: string;
  analysisModel: string;
  reportModel: string;

  // 独立平台接口配置 (可选，未设置时继承全局 llmApiBase / llmApiKey)
  analysisApiBase?: string;
  analysisApiKey?: string;
  reportApiBase?: string;
  reportApiKey?: string;
}

export const baseConfig: OtusConfig = {
  outputDir: DATA_DIR,
  dbPath: DB_PATH,
  snapshotsDir: SNAPSHOTS_DIR,
  binDir: BIN_DIR,
  tmpDir: TMP_DIR,
  maxStorageBytes: 10 * 1024 * 1024 * 1024,   // 10GB 磁盘存储硬上限
  // 7.5GiB = 8053063680 字节，与 Alma 的清理水位完全一致。
  // 注意别写成「8GB」：GiB 与 GB 差 7%，且这个值是照抄 Alma 的字节数，不是凑整。
  targetStorageBytes: 8053063680,

  // 三级生命周期（对齐 Alma Vq：hotRetentionMs / warmRetentionMs / coldRetentionMs）
  hotRetentionMs: 86400000,      // 1 天：原图
  warmRetentionMs: 604800000,    // 7 天：降到 1280×720@40
  coldRetentionMs: 2592000000,   // 30 天：降到 640×360@30，之后删文件保留 OCR 文本

  warmRecompressEnabled: true,
  warmRecompressMaxWidth: 1280,
  warmRecompressMaxHeight: 720,
  warmRecompressQuality: 40,

  coldRecompressEnabled: true,
  coldRecompressMaxWidth: 640,
  coldRecompressMaxHeight: 360,
  coldRecompressQuality: 30,

  enableInputMonitor: true,
  snapshotDebounceMs: 4000,       // 4s 抓拍防抖（对齐 Alma，原 1000ms 过密）
  typingPauseMs: 1200,
  idleThresholdMs: 30000,         // 30s 闲置自动切分会话（与 Alma 一致）
  heartbeatIntervalMs: 120000,    // 2min 心跳抓拍（对齐 Alma，原 30s 过密）
  visualCheckIntervalMs: 12000,   // 12s 画面差分检测（对齐 Alma）
  browserPollIntervalMs: 12000,   // 12s 浏览器穿透检测（对齐 Alma，原 5s 过密）

  focusPollIntervalMs: 30000,     // 30s 前台 App 采样（方案 A：长任务期间保持 App 归属）
  visualActivityWindowMs: 120000, // 画面实质变化后 2 分钟内仍算活跃（方案 B）
  taskAppWhitelist: [
    // AI / Agent 类
    "DeepSeek Harness", "Claude", "ChatGPT", "Cursor",
    "codex", "Antigravity", "WorkBuddy", "豆包工作",
    // 终端类
    "Terminal", "iTerm2", "Warp", "Ghostty", "Alacritty",
    // IDE / 编辑器
    "Visual Studio Code", "Xcode", "IntelliJ IDEA", "WebStorm",
    "Sublime Text", "Zed", "Obsidian",
    // 构建 / 系统工具
    "Docker", "Activity Monitor",
  ],

  windowTitleTimeoutMs: 800,        // 单次 AX 请求超时（正常 <10ms，超时说明目标 App 卡死）
  windowTitleBackoffBaseMs: 2000,   // 按 App 分桶退避起始
  windowTitleBackoffMaxMs: 60000,   // 退避上限
  windowTitleMaxFailures: 16,       // 指数退避幂次封顶

  sensitiveApps: [
    "com.agilebits.onepassword",
    "com.1password.1password",
    "com.bitwarden.desktop",
    "org.keepassxc.keepassxc",
    "com.apple.keychainaccess"
  ],
  ocrLanguages: ["zh-Hans", "en-US"],
  ocrEveryN: 3,                   // 每 3 张快照才执行一次 OCR（对齐 Alma，降低 Vision 开销）
  mergeGapMs: 300000,             // 5 分钟内的相邻同类会话在分析前合并（对齐 Alma）
  mergeMaxDurationMs: 180000,     // 3 分钟以内的会话视为碎片，可参与合并
  // 合并体总跨度上限。必须与 mergeGapMs（相邻间隔窗口）区分开：
  // 之前用 mergeGapMs 同时卡总跨度，导致「两个 2.5 分钟碎片」就已超 5 分钟边界，
  // 大量本该合并的会话被静默跳过。15 分钟足够把一串碎片收拢成一段有意义的活动。
  mergeMaxSpanMs: 900000,

  clusterCutDistance: 0.62,       // HAC 切割距离（相似度≈0.38 以上倾向同簇）
  clusterTimeBeta: 0.25,          // 时间连续性弱惩罚权重（封顶）
  clusterTimeTauMs: 1800000,      // 时间惩罚衰减尺度 30 分钟（超过则惩罚饱和）

  minSessionDurationMs: 30000,    // 30 秒
  minSessionEventCount: 20,       // 20 个事件
  minSessionSnapshotCount: 3,     // 3 张快照
  ocrCharBudget: 18000,           // 对齐 Alma 的 maxOcrChars
  ocrDedupThreshold: 0.9,         // 相邻文本相似度 > 0.9 视为重复
  maxOcrFrames: 400,              // 对齐 Alma

  // 截图压缩默认参数（对齐 Alma fG.jpegQuality=55；native shotDisplay max_width=2560）
  snapshotMaxWidth: 2560,
  snapshotQuality: 55,

  // 三级图像判重默认参数（对齐 Alma v0.4.193）
  histogramChangeThreshold: 0.05, // 32-bin 直方图巴氏距离阈值
  pixelDiffThreshold: 0.02,       // 像素差异比例阈值（变动 < 2% 视为重复）
  pixelTolerance: 30,             // 单像素灰度容差

  // 默认对齐本地 Magpie 网关，用户无 Magpie 时可通过 ~/.otus/config.json 或环境变量覆盖为任意 OpenAI 兼容服务
  llmApiBase: "http://127.0.0.1:3425/v1",
  llmApiKey: "magpie-local",
  analysisModel: "group/fast-scan",
  reportModel: "group/smart-router"
};

export function loadUserConfig(): Partial<OtusConfig> {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
      return JSON.parse(raw);
    } catch (err) {
      console.error(`[Otus] Failed to parse config file at ${CONFIG_FILE}:`, err);
    }
  }
  return {};
}

export function saveUserConfig(updates: Partial<OtusConfig>): OtusConfig {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const current = loadUserConfig();
  const merged = { ...current, ...updates };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf-8");
  return getEffectiveConfig();
}

/**
 * 配置项范围钳制（对齐 Alma 的 bG() 实现）。
 * 用户手写 ~/.otus/config.json 时可能填入 0、负数或非法值，
 * 若不加护栏会导致「每个周期都切分会话」这类灾难性行为。
 */
function clampConfig(cfg: OtusConfig): OtusConfig {
  // 非有限数或 <= 0 时回退到 fallback；否则取 max(fallback, value)
  const atLeast = (value: number | undefined, fallback: number): number =>
    !Number.isFinite(value) || (value as number) <= 0 ? fallback : Math.max(fallback, value as number);

  const roundTo = (value: number | undefined, fallback: number, min: number, max: number): number => {
    const n = Math.round(value as number);
    return !Number.isFinite(n) || n <= 0 ? fallback : Math.min(max, Math.max(min, n));
  };

  // 浮点参数钳制（用于 0~1 的阈值）
  const clampFloat = (value: number | undefined, fallback: number, min: number, max: number): number => {
    const n = Number(value);
    return !Number.isFinite(n) ? fallback : Math.min(max, Math.max(min, n));
  };

  return {
    ...cfg,
    snapshotDebounceMs: atLeast(cfg.snapshotDebounceMs, 3000),
    heartbeatIntervalMs: atLeast(cfg.heartbeatIntervalMs, 60000),
    typingPauseMs: atLeast(cfg.typingPauseMs, 800),
    idleThresholdMs: atLeast(cfg.idleThresholdMs, 15000),
    visualCheckIntervalMs: atLeast(cfg.visualCheckIntervalMs, 10000),
    browserPollIntervalMs: atLeast(cfg.browserPollIntervalMs, 10000),
    focusPollIntervalMs: atLeast(cfg.focusPollIntervalMs, 5000),
    visualActivityWindowMs: atLeast(cfg.visualActivityWindowMs, 30000),
    taskAppWhitelist: Array.isArray(cfg.taskAppWhitelist) ? cfg.taskAppWhitelist : [],
    windowTitleTimeoutMs: roundTo(cfg.windowTitleTimeoutMs, 800, 200, 5000),
    windowTitleBackoffBaseMs: atLeast(cfg.windowTitleBackoffBaseMs, 500),
    windowTitleBackoffMaxMs: atLeast(cfg.windowTitleBackoffMaxMs, 5000),
    windowTitleMaxFailures: roundTo(cfg.windowTitleMaxFailures, 16, 1, 20),
    ocrEveryN: roundTo(cfg.ocrEveryN, 1, 1, 10),
    snapshotQuality: roundTo(cfg.snapshotQuality, 55, 30, 95),
    snapshotMaxWidth: roundTo(cfg.snapshotMaxWidth, 2560, 320, 5120),
    maxStorageBytes: atLeast(cfg.maxStorageBytes, 512 * 1024 * 1024),
    // 目标水位必须严格小于硬上限，否则一轮清理后立刻又会超限（死循环）
    targetStorageBytes: Math.min(
      atLeast(cfg.targetStorageBytes, 256 * 1024 * 1024),
      Math.floor(atLeast(cfg.maxStorageBytes, 512 * 1024 * 1024) * 0.95)
    ),
    // 保留期必须单调递增：hot < warm < cold，否则 tier 会来回跳
    hotRetentionMs: atLeast(cfg.hotRetentionMs, 3600000),
    warmRetentionMs: Math.max(atLeast(cfg.warmRetentionMs, 86400000), atLeast(cfg.hotRetentionMs, 3600000) + 1),
    coldRetentionMs: Math.max(atLeast(cfg.coldRetentionMs, 604800000), atLeast(cfg.warmRetentionMs, 86400000) + 1),
    warmRecompressEnabled: cfg.warmRecompressEnabled !== false,
    warmRecompressMaxWidth: roundTo(cfg.warmRecompressMaxWidth, 1280, 160, 4096),
    warmRecompressMaxHeight: roundTo(cfg.warmRecompressMaxHeight, 720, 90, 4096),
    warmRecompressQuality: roundTo(cfg.warmRecompressQuality, 40, 10, 95),
    coldRecompressEnabled: cfg.coldRecompressEnabled !== false,
    coldRecompressMaxWidth: roundTo(cfg.coldRecompressMaxWidth, 640, 160, 4096),
    coldRecompressMaxHeight: roundTo(cfg.coldRecompressMaxHeight, 360, 90, 4096),
    coldRecompressQuality: roundTo(cfg.coldRecompressQuality, 30, 10, 95),
    // 判重阈值必须落在合理区间：过小会误丢真实变化，过大会产生大量重复帧
    histogramChangeThreshold: clampFloat(cfg.histogramChangeThreshold, 0.05, 0.001, 0.5),
    pixelDiffThreshold: clampFloat(cfg.pixelDiffThreshold, 0.02, 0.001, 0.5),
    pixelTolerance: roundTo(cfg.pixelTolerance, 30, 0, 255),
    // 合并窗口：过小则形同虚设，过大可能把不相关工作拼在一起
    mergeGapMs: roundTo(cfg.mergeGapMs, 300000, 60000, 1800000),
    mergeMaxDurationMs: roundTo(cfg.mergeMaxDurationMs, 180000, 30000, 1800000),
    // 跨度必须 >= 间隔窗口，否则语义上自相矛盾（间隔内能连、连起来却超跨度）
    mergeMaxSpanMs: roundTo(cfg.mergeMaxSpanMs, 900000, 60000, 3600000),
    // HAC 聚类参数：切割距离 [0.3, 0.9]、时间惩罚 β [0, 0.6]、τ [5min, 4h]
    clusterCutDistance: clampFloat(cfg.clusterCutDistance, 0.62, 0.3, 0.9),
    clusterTimeBeta: clampFloat(cfg.clusterTimeBeta, 0.25, 0, 0.6),
    clusterTimeTauMs: roundTo(cfg.clusterTimeTauMs, 1800000, 300000, 14400000),
    minSessionDurationMs: roundTo(cfg.minSessionDurationMs, 30000, 0, 600000),
    minSessionEventCount: roundTo(cfg.minSessionEventCount, 20, 0, 1000),
    minSessionSnapshotCount: roundTo(cfg.minSessionSnapshotCount, 3, 0, 100),
    ocrCharBudget: roundTo(cfg.ocrCharBudget, 18000, 1000, 64000),
    ocrDedupThreshold: clampFloat(cfg.ocrDedupThreshold, 0.9, 0.5, 1.0),
    maxOcrFrames: roundTo(cfg.maxOcrFrames, 400, 20, 2000),
  };
}

export function getEffectiveConfig(): OtusConfig {
  const user = loadUserConfig();
  return clampConfig({
    ...baseConfig,
    ...user,
    // 环境变量优先级最高
    llmApiBase: process.env.OTUS_LLM_URL || user.llmApiBase || baseConfig.llmApiBase,
    llmApiKey: process.env.OTUS_LLM_KEY || user.llmApiKey || baseConfig.llmApiKey,
    analysisModel: process.env.OTUS_ANALYSIS_MODEL || user.analysisModel || baseConfig.analysisModel,
    reportModel: process.env.OTUS_REPORT_MODEL || user.reportModel || baseConfig.reportModel,
    analysisApiBase: process.env.OTUS_ANALYSIS_URL || user.analysisApiBase || undefined,
    analysisApiKey: process.env.OTUS_ANALYSIS_KEY || user.analysisApiKey || undefined,
    reportApiBase: process.env.OTUS_REPORT_URL || user.reportApiBase || undefined,
    reportApiKey: process.env.OTUS_REPORT_KEY || user.reportApiKey || undefined,
  });
}

export const defaultConfig: OtusConfig = getEffectiveConfig();

