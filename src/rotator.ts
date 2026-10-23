import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ActivityStore } from "./store.ts";
import { defaultConfig } from "./config.ts";
import type { OtusConfig } from "./config.ts";

/**
 * 快照分层轮转器（对齐 Alma v0.4.193 的 Zq 类 / Vq 配置）。
 *
 * 三级生命周期：
 *   hot  (1 天)   原图保留，2560 宽 / 质量 55（实测 300 张均值约 250KB/张（随画面复杂度 48KB–643KB 波动））
 *   warm (7 天)   重压至 1280×720 / 质量 40（约 50KB）
 *   cold (30 天)  重压至 640×360 / 质量 30（约 15KB）
 *   超 30 天      删除文件，仅保留 SQLite 中的 OCR 文本与指标
 *
 * 为什么必须重压缩而不是直接删：
 *   截图是 OCR 的原始输入，也是事后回看的唯一证据。直接删等于 7 天后的
 *   历史完全不可回溯；降质保留能让人工回看和二次 OCR 都还有素材。
 *
 * 容量兜底：账面总占用超过 maxStorageBytes(10GB) 时，从最旧的一条开始删，
 * 直到降到 targetStorageBytes(8GB)。
 *
 * 注：重压缩用 macOS 原生 sips（`sips -Z` 等比缩放 + formatOptions 质量），
 * 与 recorder 的压缩路径保持一致，不引入任何 npm 依赖。
 */
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
    // 启动 10 分钟后跑首次检查（避开 daemon 启动时的截图高峰），之后每 4 小时一次
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

  public async runOnce(): Promise<{
    demoted: number;
    recompressed: number;
    deleted: number;
    bytesFreed: number;
  }> {
    if (this.running) return { demoted: 0, recompressed: 0, deleted: 0, bytesFreed: 0 };
    this.running = true;

    let demoted = 0;
    let recompressed = 0;
    let deleted = 0;
    let bytesFreed = 0;

    try {
      const now = Date.now();
      const cfg = this.config;

      // 阶段 1 & 2：hot → warm → cold 降级（重压缩优先，失败则仅改 tier 不删文件）
      const stages: Array<{
        tier: "hot" | "warm";
        nextTier: "warm" | "cold";
        thresholdMs: number;
        maxWidth: number;
        maxHeight: number;
        quality: number;
        enabled: boolean;
      }> = [
        {
          tier: "hot",
          nextTier: "warm",
          thresholdMs: cfg.hotRetentionMs,
          maxWidth: cfg.warmRecompressMaxWidth,
          maxHeight: cfg.warmRecompressMaxHeight,
          quality: cfg.warmRecompressQuality,
          enabled: cfg.warmRecompressEnabled
        },
        {
          tier: "warm",
          nextTier: "cold",
          thresholdMs: cfg.warmRetentionMs,
          maxWidth: cfg.coldRecompressMaxWidth,
          maxHeight: cfg.coldRecompressMaxHeight,
          quality: cfg.coldRecompressQuality,
          enabled: cfg.coldRecompressEnabled
        }
      ];

      for (const stage of stages) {
        const snaps = this.store.listSnapshotsForTier(stage.tier, 500);
        for (const snap of snaps) {
          if (now - snap.timestamp <= stage.thresholdMs) continue;

          let saved = 0;
          if (stage.enabled && snap.filePath) {
            saved = this.recompressSnapshot(snap, stage.maxWidth, stage.maxHeight, stage.quality, stage.nextTier);
          }
          if (saved > 0) {
            recompressed++;
            bytesFreed += saved;
          } else {
            // 重压缩不可用/无收益：只降 tier，绝不因此删文件
            this.store.setSnapshotTier(snap.id, stage.nextTier);
            demoted++;
          }
        }
      }

      // 阶段 3：cold 超过保留期 → 删除文件，保留 OCR 文本与指标
      const coldSnaps = this.store.listSnapshotsForTier("cold", 2000);
      for (const snap of coldSnaps) {
        if (now - snap.timestamp <= cfg.coldRetentionMs) continue;
        bytesFreed += this.removeFile(snap.filePath);
        this.store.deleteSnapshot(snap.id);
        deleted++;
      }

      // 阶段 4：容量兜底 —— 超过硬上限时按时间从旧到新删到目标水位
      let total = this.store.totalStorageBytes();
      if (total > cfg.maxStorageBytes) {
        console.warn(
          `[ActivityRotator] 账面占用 ${Math.round(total / 1024 / 1024)}MB 超过上限 ${Math.round(cfg.maxStorageBytes / 1024 / 1024)}MB，开始按时间清理`
        );
        const candidates = [
          ...this.store.listSnapshotsForTier("cold", 4000),
          ...this.store.listSnapshotsForTier("warm", 4000),
          ...this.store.listSnapshotsForTier("hot", 4000)
        ].sort((a, b) => a.timestamp - b.timestamp);

        for (const snap of candidates) {
          if (total <= cfg.targetStorageBytes) break;
          const freed = this.removeFile(snap.filePath);
          this.store.deleteSnapshot(snap.id);
          deleted++;
          bytesFreed += freed;
          total -= snap.sizeBytes || freed;
        }
      }

      if (demoted || recompressed || deleted) {
        const freedKb = bytesFreed / 1024;
        const freedText = freedKb >= 1024 ? `${Math.round(freedKb / 1024)}MB` : `${Math.round(freedKb)}KB`;
        console.log(
          `[ActivityRotator] demoted=${demoted} recompressed=${recompressed} deleted=${deleted} bytesFreed=${freedText}`
        );
      }
    } catch (err) {
      console.error("[ActivityRotator] runOnce 异常：", String((err as any)?.message || err));
    } finally {
      this.running = false;
    }

    return { demoted, recompressed, deleted, bytesFreed };
  }

  /**
   * 用 sips 等比缩放到不超过 maxWidth×maxHeight，并重压为指定质量。
   *
   * 只有当新文件确实更小时才替换（Alma 的 `if (u.length >= n) return` 同款判断），
   * 否则只降 tier、保留原图，避免「重压缩反而变大」的退化。
   *
   * @returns 实际节省的字节数；0 表示未替换
   */
  private recompressSnapshot(
    snap: { id: string; filePath: string; sizeBytes: number; width: number; height: number },
    maxWidth: number,
    maxHeight: number,
    quality: number,
    nextTier: "warm" | "cold"
  ): number {
    try {
      const src = path.isAbsolute(snap.filePath) ? snap.filePath : path.resolve(snap.filePath);
      if (!fs.existsSync(src)) {
        // 文件已不在（手动删过/盘被清理）：只改 tier，等下一轮被保留期或容量回收
        this.store.setSnapshotTier(snap.id, nextTier);
        return 0;
      }

      const tmp = `${src}.recompress.jpg`;
      // sips -Z 只按长边等比缩放。Alma 用 fit:inside 落在 w×h 框内，
      // 对 16:10 屏而言长边即宽，取 maxWidth 语义等价。
      execFileSync(
        "/usr/bin/sips",
        ["-Z", String(maxWidth), "-s", "formatOptions", String(quality), src, "--out", tmp],
        { stdio: "ignore", timeout: 5000 }
      );

      if (!fs.existsSync(tmp)) return 0;
      const newSize = fs.statSync(tmp).size;
      const oldSize = snap.sizeBytes || fs.statSync(src).size;

      // 没变小就不替换（Alma: if (u.length >= n) return setTier + 0）
      if (newSize >= oldSize) {
        try { fs.unlinkSync(tmp); } catch {}
        this.store.setSnapshotTier(snap.id, nextTier);
        return 0;
      }

      // png 会在重压后变成 jpg，同步改扩展名，避免路径与实际格式不符
      let finalPath = src;
      if (src.toLowerCase().endsWith(".png")) {
        finalPath = src.replace(/\.png$/i, ".jpg");
      }
      fs.renameSync(tmp, finalPath);
      if (finalPath !== src) {
        try { fs.unlinkSync(src); } catch {}
      }

      const dims = this.readDims(finalPath);
      this.store.updateSnapshotAfterRecompress(snap.id, {
        sizeBytes: newSize,
        width: dims.width,
        height: dims.height,
        filePath: finalPath,
        tier: nextTier
      });

      return Math.max(0, oldSize - newSize);
    } catch {
      // 单张重压缩失败不影响整轮；保守起见只降 tier
      try { this.store.setSnapshotTier(snap.id, nextTier); } catch {}
      return 0;
    }
  }

  /** 读 sips -g 的像素尺寸；失败时返回 0，调用方容忍 */
  private readDims(filePath: string): { width: number; height: number } {
    try {
      const out = execFileSync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", filePath], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"]
      });
      const w = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1] || 0);
      const h = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1] || 0);
      return { width: w, height: h };
    } catch {
      return { width: 0, height: 0 };
    }
  }

  private removeFile(filePath: string): number {
    if (!filePath) return 0;
    try {
      const p = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
      if (!fs.existsSync(p)) return 0;
      const size = fs.statSync(p).size;
      fs.unlinkSync(p);
      return size;
    } catch {
      return 0;
    }
  }
}
