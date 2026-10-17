import fs from "node:fs";
import path from "node:path";
import { ActivityStore } from "./store.ts";
import { ActivitySummarizer } from "./summarizer.ts";
import { defaultConfig } from "./config.ts";
import type { OtusConfig } from "./config.ts";

export class ReportRenderer {
  private store: ActivityStore;
  private summarizer: ActivitySummarizer;
  private config: OtusConfig;

  constructor(store: ActivityStore, config: Partial<OtusConfig> = {}) {
    this.store = store;
    this.config = { ...defaultConfig, ...config };
    this.summarizer = new ActivitySummarizer(store, config);
  }

  public async renderHtmlReport(dateKey?: string): Promise<{ html: string; outputPath: string }> {
    const today = new Date().toISOString().slice(0, 10);
    const targetDate = dateKey || today;

    // 1. 生成或获取日终总结数据
    const reportData = await this.summarizer.generateDailyReport(targetDate);

    // 2. 计算 180 槽位 GitHub 绿阶心流矩阵 (07:00 - 22:00, 15小时 * 12格 = 180格)
    const [year, month, day] = targetDate.split("-").map(Number);
    const startOfDay = new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
    const endOfDay = new Date(year, month - 1, day + 1, 0, 0, 0, 0).getTime();
    const sessions = this.store.listSessions({ since: startOfDay, until: endOfDay, limit: 1000 });

    const slots = new Array(180).fill(0); // 0~4
    const slotMinutes = new Array(180).fill(0); // 记录每个槽位的累计活跃分钟

    for (const sess of sessions) {
      const sessStart = sess.startedAt;
      const sessEnd = sess.endedAt || sess.startedAt + (sess.durationMs || 0);

      // 计算覆盖的 5 分钟 slot (07:00 开始)
      const baseTime = new Date(year, month - 1, day, 7, 0, 0, 0).getTime();
      const endTime = new Date(year, month - 1, day, 22, 0, 0, 0).getTime();

      const clampedStart = Math.max(sessStart, baseTime);
      const clampedEnd = Math.min(sessEnd, endTime);

      if (clampedStart < clampedEnd) {
        const startSlot = Math.floor((clampedStart - baseTime) / 300000);
        const endSlot = Math.floor((clampedEnd - baseTime) / 300000);
        for (let s = Math.max(0, startSlot); s <= Math.min(179, endSlot); s++) {
          slotMinutes[s] += 1;
        }
      }
    }

    // 映射到绿阶 0~4
    for (let i = 0; i < 180; i++) {
      const m = slotMinutes[i];
      if (m <= 0) slots[i] = 0;
      else if (m === 1) slots[i] = 1;
      else if (m <= 2) slots[i] = 2;
      else if (m <= 4) slots[i] = 3;
      else slots[i] = 4;
    }

    // 3. 计算 24 小时分布
    const hours = new Array(24).fill(0);
    for (const s of sessions) {
      const h = new Date(s.startedAt).getHours();
      if (h >= 0 && h < 24) hours[h]++;
    }

    // 4. 读取 template.html
    const templatePath = path.resolve(import.meta.dirname, "../assets/template.html");
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Template not found at: ${templatePath}`);
    }
    const templateContent = fs.readFileSync(templatePath, "utf-8");

    // 5. 组装注入数据
    const clientPayload = {
      date: targetDate,
      markdown: reportData.markdown,
      stats: reportData.stats,
      slots,
      hours: hours.map((count, hour) => ({ hour, count })),
      topApps: reportData.stats.topApps || []
    };

    let html = templateContent.replace(/<!--__DATE__-->/g, targetDate);

    const headMarkup = `
      <div class="head">
        <div class="head-left">
          <h1><span class="dot"></span>Otus 个人折腾日记</h1>
          <div class="sub">${targetDate} · 个人独立探索、Coding & Tinkering 记录流</div>
        </div>
        <div class="head-right">${reportData.stats.totalActiveMinutes || 0} MINS ACTIVE · ${reportData.stats.sessionCount || 0} SESSIONS</div>
      </div>
    `;
    html = html.replace(/<!--__OTUS_HEAD_AND_STATS__-->/g, headMarkup);

    html = html.replace(/\/\*__DATA__\*\/[\s\S]*?\/\*__DATA_END__\*\//, `window.__OTUS_DATA__ = ${JSON.stringify(clientPayload)};`);

    // 如果模板中没有该注释块，则挂在 </head> 之前
    if (!html.includes("window.__OTUS_DATA__")) {
      html = html.replace("</head>", `<script>window.__OTUS_DATA__ = ${JSON.stringify(clientPayload)};</script>\n</head>`);
    }

    // 6. 保存导出文件
    const outDir = path.join(this.config.outputDir, "reports");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${targetDate}.html`);
    fs.writeFileSync(outPath, html, "utf-8");

    return { html, outputPath: outPath };
  }
}
