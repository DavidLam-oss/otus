import path from "node:path";
import os from "node:os";

const homeDir = os.homedir();
export const DATA_DIR = path.join(homeDir, ".otus");
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

  sensitiveApps: string[];
  ocrLanguages: string[];

  // 截图压缩配置 (1280 宽度 + 40 质量，体积缩减 98%)
  snapshotMaxWidth: number;
  snapshotQuality: number;

  // LLM Config
  llmApiBase: string;
  llmApiKey: string;
  analysisModel: string;
  reportModel: string;
}

export const defaultConfig: OtusConfig = {
  outputDir: DATA_DIR,
  dbPath: DB_PATH,
  snapshotsDir: SNAPSHOTS_DIR,
  binDir: BIN_DIR,
  tmpDir: TMP_DIR,
  maxStorageBytes: 10 * 1024 * 1024 * 1024, // 10GB 磁盘存储硬上限，达到自动 FIFO 轮转清理旧截图

  enableInputMonitor: true,
  snapshotDebounceMs: 1000,
  typingPauseMs: 1500,
  idleThresholdMs: 30000,         // 30s 闲置自动切分会话
  heartbeatIntervalMs: 30000,     // 30s 心跳抓拍
  visualCheckIntervalMs: 10000,   // 10s 画面差分检测
  browserPollIntervalMs: 5000,    // 5s 浏览器穿透检测

  sensitiveApps: [
    "com.agilebits.onepassword",
    "com.1password.1password",
    "com.bitwarden.desktop",
    "org.keepassxc.keepassxc",
    "com.apple.keychainaccess"
  ],
  ocrLanguages: ["zh-Hans", "en-US"],

  // 截图压缩默认参数 (1280 宽度 + 40 质量)
  snapshotMaxWidth: 1280,
  snapshotQuality: 40,

  // 默认直接对齐本地 Magpie 网关，亦可通过环境变量覆盖
  llmApiBase: process.env.OTUS_LLM_URL || "http://127.0.0.1:3425/v1",
  llmApiKey: process.env.OTUS_LLM_KEY || "magpie-local",
  analysisModel: process.env.OTUS_ANALYSIS_MODEL || "workbuddy-ai/deepseek-v4.1-flash-sg",
  reportModel: process.env.OTUS_REPORT_MODEL || "workbuddy-ai/deepseek-v4.1-flash-sg"
};
