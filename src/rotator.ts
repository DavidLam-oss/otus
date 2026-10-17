import fs from "node:fs";
import path from "node:path";
import { ActivityStore } from "./store.ts";
import { defaultConfig } from "./config.ts";
import type { OtusConfig } from "./config.ts";

export class ActivityRotator {
  private store: ActivityStore;
  private config: OtusConfig;
  private timer: NodeJS.Timeout | null = null;
  private running: boolean = false;

  constructor(store: ActivityStore, config: Partial<OtusConfig> = {}) {
    this.store = store;
    this.config = { ...defaultConfig, ...config };
  }

  public start(): void {
    if (this.timer) return;
    // 启动 10 分钟后跑首次检查，之后每 4 小时检查一次
    setTimeout(() => {
      this.runOnce().catch((err) => console.error("[ActivityRotator] First run error:", err));
    }, 600000);

    this.timer = setInterval(() => {
      this.runOnce().catch((err) => console.error("[ActivityRotator] Periodic run error:", err));
    }, 4 * 3600000);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async runOnce(): Promise<{ deleted: number; bytesFreed: number }> {
    if (this.running) return { deleted: 0, bytesFreed: 0 };
    this.running = true;
    let deleted = 0;
    let bytesFreed = 0;

    try {
      const snapDir = this.config.snapshotsDir;
      if (!fs.existsSync(snapDir)) return { deleted: 0, bytesFreed: 0 };

      const dateDirs = fs.readdirSync(snapDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
      const now = Date.now();
      const SEVEN_DAYS_MS = 7 * 86400000;

      // 阶段 1：时间维度轮转 —— 超过 7 天的旧截图，删除本地大图，仅保留 SQLite 中的 OCR 文本与指标
      for (const d of dateDirs) {
        const [y, m, day] = d.split("-").map(Number);
        const dirTime = new Date(y, m - 1, day).getTime();
        if (now - dirTime > SEVEN_DAYS_MS) {
          const fullPath = path.join(snapDir, d);
          const files = fs.readdirSync(fullPath);
          for (const f of files) {
            const p = path.join(fullPath, f);
            try {
              const stat = fs.statSync(p);
              bytesFreed += stat.size;
              fs.unlinkSync(p);
              deleted++;
            } catch {}
          }
          try {
            fs.rmdirSync(fullPath);
          } catch {}
        }
      }

      // 阶段 2：容量维度安全水印 —— 达到 10GB 硬上限时，按 FIFO（最旧日期优先）循环清理至 8GB
      let totalUsageBytes = 0;
      const remainingDirs = fs.readdirSync(snapDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
      const dirSizeMap = new Map<string, { files: string[]; size: number }>();

      for (const d of remainingDirs) {
        const fullPath = path.join(snapDir, d);
        let dirBytes = 0;
        const files: string[] = [];
        try {
          const list = fs.readdirSync(fullPath);
          for (const f of list) {
            const p = path.join(fullPath, f);
            try {
              const s = fs.statSync(p);
              dirBytes += s.size;
              files.push(p);
            } catch {}
          }
        } catch {}
        totalUsageBytes += dirBytes;
        dirSizeMap.set(d, { files, size: dirBytes });
      }

      const maxLimit = this.config.maxStorageBytes || 10 * 1024 * 1024 * 1024; // 10GB
      const lowWatermark = maxLimit * 0.8; // 8GB

      if (totalUsageBytes > maxLimit) {
        console.warn(`[ActivityRotator] Snapshot disk usage (${Math.round(totalUsageBytes / 1024 / 1024)}MB) exceeded 10GB cap. Purging oldest days...`);
        for (const d of remainingDirs) {
          if (totalUsageBytes <= lowWatermark) break;
          const info = dirSizeMap.get(d);
          if (!info) continue;

          for (const p of info.files) {
            try {
              const s = fs.statSync(p);
              bytesFreed += s.size;
              totalUsageBytes -= s.size;
              fs.unlinkSync(p);
              deleted++;
            } catch {}
          }
          try {
            fs.rmdirSync(path.join(snapDir, d));
          } catch {}
        }
      }

      if (deleted > 0) {
        console.log(`[ActivityRotator] Freed ${Math.round(bytesFreed / 1024 / 1024)}MB (${deleted} old snapshots deleted)`);
      }
    } finally {
      this.running = false;
    }

    return { deleted, bytesFreed };
  }
}
