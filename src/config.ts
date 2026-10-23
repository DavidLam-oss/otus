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

  enableInputMonitor: boolean;
  snapshotDebounceMs: number;
  typingPauseMs: number;
  idleThresholdMs: number;
  heartbeatIntervalMs: number;
  visualCheckIntervalMs: number;
  browserPollIntervalMs: number;

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

  // 截图压缩配置 (1280 宽度 + 40 质量，体积缩减 98%)
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
  maxStorageBytes: 10 * 1024 * 1024 * 1024, // 10GB 磁盘存储硬上限，达到自动 FIFO 轮转清理旧截图

  enableInputMonitor: true,
  snapshotDebounceMs: 4000,       // 4s 抓拍防抖（对齐 Alma，原 1000ms 过密）
  typingPauseMs: 1200,
  idleThresholdMs: 30000,         // 30s 闲置自动切分会话（与 Alma 一致）
  heartbeatIntervalMs: 120000,    // 2min 心跳抓拍（对齐 Alma，原 30s 过密）
  visualCheckIntervalMs: 12000,   // 12s 画面差分检测（对齐 Alma）
  browserPollIntervalMs: 12000,   // 12s 浏览器穿透检测（对齐 Alma，原 5s 过密）

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

  clusterCutDistance: 0.62,       // HAC 切割距离（相似度≈0.38 以上倾向同簇）
  clusterTimeBeta: 0.25,          // 时间连续性弱惩罚权重（封顶）
  clusterTimeTauMs: 1800000,      // 时间惩罚衰减尺度 30 分钟（超过则惩罚饱和）

  minSessionDurationMs: 30000,    // 30 秒
  minSessionEventCount: 20,       // 20 个事件
  minSessionSnapshotCount: 3,     // 3 张快照
  ocrCharBudget: 18000,           // 对齐 Alma 的 maxOcrChars
  ocrDedupThreshold: 0.9,         // 相邻文本相似度 > 0.9 视为重复
  maxOcrFrames: 400,              // 对齐 Alma

  // 截图压缩默认参数 (1280 宽度 + 40 质量)
  snapshotMaxWidth: 1280,
  snapshotQuality: 40,

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
    windowTitleTimeoutMs: roundTo(cfg.windowTitleTimeoutMs, 800, 200, 5000),
    windowTitleBackoffBaseMs: atLeast(cfg.windowTitleBackoffBaseMs, 500),
    windowTitleBackoffMaxMs: atLeast(cfg.windowTitleBackoffMaxMs, 5000),
    windowTitleMaxFailures: roundTo(cfg.windowTitleMaxFailures, 16, 1, 20),
    ocrEveryN: roundTo(cfg.ocrEveryN, 1, 1, 10),
    snapshotQuality: roundTo(cfg.snapshotQuality, 40, 30, 95),
    snapshotMaxWidth: roundTo(cfg.snapshotMaxWidth, 1280, 320, 3840),
    maxStorageBytes: atLeast(cfg.maxStorageBytes, 512 * 1024 * 1024),
    // 判重阈值必须落在合理区间：过小会误丢真实变化，过大会产生大量重复帧
    histogramChangeThreshold: clampFloat(cfg.histogramChangeThreshold, 0.05, 0.001, 0.5),
    pixelDiffThreshold: clampFloat(cfg.pixelDiffThreshold, 0.02, 0.001, 0.5),
    pixelTolerance: roundTo(cfg.pixelTolerance, 30, 0, 255),
    // 合并窗口：过小则形同虚设，过大可能把不相关工作拼在一起
    mergeGapMs: roundTo(cfg.mergeGapMs, 300000, 60000, 1800000),
    mergeMaxDurationMs: roundTo(cfg.mergeMaxDurationMs, 180000, 30000, 1800000),
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

