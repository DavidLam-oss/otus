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
    // 启动 1 小时后跑一次，之后每 6 小时检查一次
    setTimeout(() => {
      this.runOnce().catch((err) => console.error("[ActivityRotator] First run error:", err));
    }, 3600000);

    this.timer = setInterval(() => {
      this.runOnce().catch((err) => console.error("[ActivityRotator] Periodic run error:", err));
    }, 6 * 3600000);
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

      for (const d of dateDirs) {
        const [y, m, day] = d.split("-").map(Number);
        const dirTime = new Date(y, m - 1, day).getTime();
        // 超过 7 天的旧截图，删除本地大图文件，仅保留 SQLite 里的 OCR 文字与统计
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

      if (deleted > 0) {
        console.log(`[ActivityRotator] Freed ${Math.round(bytesFreed / 1024 / 1024)}MB (${deleted} old snapshots deleted)`);
      }
    } finally {
      this.running = false;
    }

    return { deleted, bytesFreed };
  }
}
