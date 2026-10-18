import fs from "node:fs";
import path from "node:path";
import { ActivityStore } from "./store.ts";
import { ActivitySummarizer } from "./summarizer.ts";
import { defaultConfig, getLocalDateKey } from "./config.ts";
import type { OtusConfig } from "./config.ts";

const PALETTE = [
  "#58a6ff", // blue
  "#3fb950", // green
  "#a371f7", // purple
  "#f778ba", // pink
  "#d29922", // yellow/warn
  "#79c0ff", // cyan
  "#bc8cff", // lavender
  "#56d364", // emerald
  "#e3b341", // amber
  "#ff7b72"  // coral
];

export class ReportRenderer {
  private store: ActivityStore;
  private summarizer: ActivitySummarizer;
  private config: OtusConfig;

  constructor(store: ActivityStore, config: Partial<OtusConfig> = {}) {
    this.store = store;
    this.config = { ...defaultConfig, ...config };
    this.summarizer = new ActivitySummarizer(store, config);
  }

  public async renderHtmlReport(
    dateKey?: string,
    opts: { force?: boolean } = {}
  ): Promise<{ html: string; outputPath: string }> {
    const today = getLocalDateKey();
    const targetDate = dateKey || today;

    // 1. 生成或获取日终总结数据
    const reportData = await this.summarizer.generateDailyReport(targetDate, { force: opts.force });
    const stats = reportData.stats || {};

    // 2. 提取当天所有 session
    const [year, month, day] = targetDate.split("-").map(Number);
    const startOfDay = new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
    const endOfDay = new Date(year, month - 1, day + 1, 0, 0, 0, 0).getTime();
    const TOPIC_NAMES: Record<string, string> = {
      "antigravity": "Antigravity",
      "obsidian-wechat-converter": "微信排版插件",
      "obsidian": "Obsidian",
      "wechat": "微信生态",
      "google chrome": "Chrome 检索",
      "google_chrome": "Chrome 检索",
      "chrome": "Chrome 检索",
      "otus": "Otus 研发",
      "ghostty": "Ghostty 终端",
      "comet": "Comet 浏览",
      "magpie": "Magpie 路由",
      "noterelay": "NoteRelay",
      "domains": "域名服务",
      "misc": "其他零碎"
    };

    const getDisplayName = (key: string, rawName: string): string => {
      const lower = key.toLowerCase();
      if (TOPIC_NAMES[lower]) return TOPIC_NAMES[lower];
      if (/[\u4e00-\u9fa5]/.test(rawName)) return rawName;
      return rawName.charAt(0).toUpperCase() + rawName.slice(1);
    };

    const allSessions = this.store.listSessions({ since: startOfDay, until: endOfDay, limit: 2000 });
    const analyzedSessions = allSessions.filter((s) => {
      if (s.analysisStatus !== "analyzed") return false;
      const app = (s.appNames[0] || "").toLowerCase();
      if (["loginwindow", "screensaverengine", "lockscreen", "screensaver"].includes(app)) return false;
      const title = (s.analysisTitle || "").toLowerCase();
      if (title.startsWith("loginwindow") || title.startsWith("idle /") || title.includes("系统锁屏闲置")) return false;
      return true;
    });

    // 3. 构建 rawSlots (每条 [hour, minute, durationMinutes])
    const rawSlots: [number, number, number][] = [];
    for (const sess of allSessions) {
      const d = new Date(sess.startedAt);
      const h = d.getHours();
      const m = d.getMinutes();
      const durMin = Math.max(1, Math.round((sess.durationMs || 0) / 60000));
      rawSlots.push([h, m, durMin]);
    }

    // 4. 计算各主题时长聚合，生成 themes 与 labels 字典
    const themeDurationMap = new Map<string, { name: string; minutes: number }>();
    for (const sess of analyzedSessions) {
      const dur = Math.max(1, Math.round((sess.durationMs || 0) / 60000));
      const key = (sess.project || sess.topics?.[0] || sess.appNames[0] || "misc")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "_");
      const rawName = sess.project || sess.topics?.[0] || sess.appNames[0] || "其他零碎";
      const displayName = getDisplayName(key, rawName);

      const current = themeDurationMap.get(key) || { name: displayName, minutes: 0 };
      current.minutes += dur;
      themeDurationMap.set(key, current);
    }

    // 按时长降序排序
    const sortedThemes = [...themeDurationMap.entries()].sort((a, b) => b[1].minutes - a[1].minutes);

    // 约定最多展示 10 个分类：前 9 个主要分类保留，其余合并为「其他零碎」
    const TOP_LIMIT = 9;
    const finalThemesMap = new Map<string, { name: string; minutes: number }>();
    let miscMinutes = 0;

    sortedThemes.forEach(([key, val], idx) => {
      if (idx < TOP_LIMIT && key !== "misc") {
        finalThemesMap.set(key, val);
      } else {
        miscMinutes += val.minutes;
      }
    });

    if (miscMinutes > 0 || finalThemesMap.size === 0) {
      finalThemesMap.set("misc", { name: "其他零碎", minutes: miscMinutes });
    }

    const themes: [string, number, string, string][] = [];
    const labels: Record<string, [string, string, string]> = {};
    const cssRules: string[] = [];

    let colorIdx = 0;
    for (const [key, val] of finalThemesMap.entries()) {
      const color = key === "misc" ? "#8b949e" : PALETTE[colorIdx % PALETTE.length];
      if (key !== "misc") colorIdx++;
      const cssClass = `t-${key}`;
      themes.push([val.name, val.minutes, color, key]);
      labels[key] = [val.name, cssClass, color];
      cssRules.push(`.topic.${cssClass} { background: ${color}22; color: ${color}; border: 1px solid ${color}44; }`);
    }

    // 默认兜底 label
    if (!labels["misc"]) {
      labels["misc"] = ["其他零碎", "t-misc", "#8b949e"];
      cssRules.push(`.topic.t-misc { background: rgba(139,148,158,0.15); color: #8b949e; border: 1px solid rgba(139,148,158,0.3); }`);
    }

    // 5. 构建时间线 tlData: [timeStr, durationStr, title, topicKey]
    const tlData: [string, string, string, string][] = [];
    for (const s of analyzedSessions) {
      const d = new Date(s.startedAt);
      const timeStr = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      const durMin = Math.max(1, Math.round((s.durationMs || 0) / 60000));
      const durStr = `${durMin}m`;
      const fallbackTitle = s.appNames[0] ? `在 ${s.appNames[0]} 中操作` : "日常专注折腾";
      const title = s.analysisTitle || fallbackTitle;
      const rawKey = (s.project || s.topics?.[0] || s.appNames[0] || "misc")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "_");
      const topicKey = finalThemesMap.has(rawKey) ? rawKey : "misc";
      tlData.push([timeStr, durStr, title, topicKey]);
    }

    // 6. 读取 template.html
    const templatePath = path.resolve(import.meta.dirname, "../assets/template.html");
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Template not found at: ${templatePath}`);
    }
    let html = fs.readFileSync(templatePath, "utf-8");

    // 7. 注入数据与替换占位符
    html = html.replace(/<!--__DATE__-->/g, targetDate);

    // 注入 CSS
    html = html.replace(/\/\*__OTUS_TOPIC_CSS__\*\//g, cssRules.join("\n"));

    // 注入 JS 核心数据源 (解决原先模板数据为空的 Bug)
    html = html.replace(/\/\*__OTUS_LABELS__\*\/\s*\{\}/g, JSON.stringify(labels));
    html = html.replace(/\/\*__OTUS_RAW_SLOTS__\*\/\s*\[\]/g, JSON.stringify(rawSlots));
    html = html.replace(/\/\*__OTUS_TL_DATA__\*\/\s*\[\]/g, JSON.stringify(tlData));
    html = html.replace(/\/\*__OTUS_THEMES__\*\/\s*\[\]/g, JSON.stringify(themes));

    // 头部 KPI 指标卡 (100% 实时从 SQLite 会话计算，确保指标、心流热力图与时间线绝对同步)
    const liveTotalActiveMinutes = Math.round(allSessions.reduce((acc, s) => acc + (s.durationMs || 0), 0) / 60000);
    const liveAnalyzedCount = analyzedSessions.length;
    const liveSessionCount = allSessions.length;
    const liveFilteredCount = Math.max(0, liveSessionCount - liveAnalyzedCount);

    const liveAppDurations = new Map<string, number>();
    for (const sess of allSessions) {
      const app = sess.appNames[0] || "Desktop";
      liveAppDurations.set(app, (liveAppDurations.get(app) || 0) + (sess.durationMs || 0));
    }
    const liveTopAppEntry = [...liveAppDurations.entries()].sort((a, b) => b[1] - a[1])[0];
    const liveTopAppName = liveTopAppEntry ? liveTopAppEntry[0] : (stats.topApps?.[0]?.app || "Desktop");
    const liveTopAppMins = liveTopAppEntry ? Math.round(liveTopAppEntry[1] / 60000) : (stats.topApps?.[0]?.minutes || 0);

    const efficiencyPct = liveSessionCount > 0 ? Math.round((liveAnalyzedCount / liveSessionCount) * 100) : (stats.sessionCount > 0 ? Math.round(((stats.analyzedCount || 0) / stats.sessionCount) * 100) : 100);

    const headMarkup = `
      <div class="head">
        <div class="head-left">
          <h1><span class="dot"></span>Otus 个人折腾日记</h1>
          <div class="sub">${targetDate} · 个人独立探索、Coding & Tinkering 记录流</div>
        </div>
        <div class="head-right">${liveTotalActiveMinutes} MINS ACTIVE · ${liveSessionCount} SESSIONS</div>
      </div>
      <div class="stats">
        <div class="stat">
          <div class="top-row"><span class="n blue">${liveTotalActiveMinutes}m</span><span class="badge">FOCUS</span></div>
          <div class="l">全天活跃专注</div>
          <div class="sub-l">覆盖 07:00–22:00</div>
        </div>
        <div class="stat">
          <div class="top-row"><span class="n green">${liveAnalyzedCount}</span><span class="badge">SESSIONS</span></div>
          <div class="l">实质折腾会话</div>
          <div class="sub-l">${liveFilteredCount} 个闲置已过滤</div>
        </div>
        <div class="stat">
          <div class="top-row"><span class="n purple">${finalThemesMap.size || stats.clusterCount || 0}</span><span class="badge">THEMES</span></div>
          <div class="l">核心聚类主题</div>
          <div class="sub-l">Jaccard ≥ 0.18</div>
        </div>
        <div class="stat">
          <div class="top-row"><span class="n warn">${liveTopAppName}</span><span class="badge">TOP APP</span></div>
          <div class="l">最高时长应用</div>
          <div class="sub-l">${liveTopAppMins}m 投入</div>
        </div>
      </div>
    `;
    html = html.replace(/<!--__OTUS_HEAD_AND_STATS__-->/g, headMarkup);

    // 连贯专注与效率指示卡
    const streakBox = `
      <div style="margin-top: 14px; padding: 12px 14px; background: var(--panel2); border-radius: 8px; border: 1px solid var(--border); font-size: 12px; display: flex; justify-content: space-between; align-items: center;">
        <div>
          <div style="color: var(--muted); font-size: 11px;">折腾信噪比</div>
          <div style="font-size: 16px; font-weight: 700; color: var(--accent); font-family: var(--mono);">${efficiencyPct}%</div>
        </div>
        <div style="text-align: right;">
          <div style="color: var(--muted); font-size: 11px;">实质折腾数</div>
          <div style="font-size: 16px; font-weight: 700; color: var(--good); font-family: var(--mono);">${liveAnalyzedCount} / ${liveSessionCount}</div>
        </div>
      </div>
    `;
    html = html.replace(/<!--__OTUS_STREAK_BOX__-->/g, streakBox);

    // 渲染主题深度折腾记录
    const deepDiveHtml = `
      <div class="sec-head">
        <h2>主题深度折腾记录 (Thematic Deep Dive)</h2>
      </div>
      <div class="card" style="padding: 24px 28px;">
        ${this.renderMarkdownToHtml(reportData.markdown)}
      </div>
    `;
    html = html.replace(/<!--__OTUS_THEMATIC_DEEP_DIVE__-->/g, deepDiveHtml);

    // 工作流复盘与洞察（高价值复盘卡片）
    let insightsHtml = "";
    if (reportData.insights && reportData.insights.length > 0) {
      insightsHtml = reportData.insights
        .map((ins) => {
          const typeCls = ins.type === "good" ? "ins good" : ins.type === "ai" ? "ins ai" : "ins";
          return `
            <div class="${typeCls}">
              <div class="h"><span class="tag">${this.escapeHtml(ins.tag)}</span> ${this.escapeHtml(ins.title)}</div>
              <div class="b">${this.formatInline(ins.content)}</div>
            </div>
          `;
        })
        .join("\n");
    } else {
      const topAppStr = stats.topApps?.slice(0, 3).map((a: any) => `${a.app} (${a.minutes}m)`).join("、") || "桌面探索";
      insightsHtml = `
        <div class="ins good">
          <div class="h"><span class="tag">主攻聚焦</span> 全天深度深耕 ${this.escapeHtml(topAppStr)}</div>
          <div class="b">全天有效折腾会话 <strong>${stats.analyzedCount || 0} 个</strong>，聚类出 ${stats.clusterCount || 0} 个清晰的推进主题。</div>
        </div>
        <div class="ins">
          <div class="h"><span class="tag">心流节奏</span> 累计活跃专注 ${stats.totalActiveMinutes || 0} 分钟</div>
          <div class="b">已自动过滤 ${stats.filteredCount || 0} 个碎片无输入或锁屏闲置会话，折腾信噪比达到 <strong>${efficiencyPct}%</strong>。</div>
        </div>
      `;
    }
    html = html.replace(/<!--__OTUS_INSIGHTS_GRID__-->/g, insightsHtml);

    // 8. 写入并保存报告
    const outDir = path.join(this.config.outputDir, "reports");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${targetDate}.html`);
    fs.writeFileSync(outPath, html, "utf-8");

    return { html, outputPath: outPath };
  }

  private renderMarkdownToHtml(md: string): string {
    const lines = md.split("\n");
    const htmlParts: string[] = [];
    let inList = false;

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        if (inList) { htmlParts.push("</ul>"); inList = false; }
        continue;
      }

      if (trimmed.startsWith("# ")) {
        if (inList) { htmlParts.push("</ul>"); inList = false; }
        continue; // 标题已在顶部卡片展示
      }

      if (trimmed.startsWith("## ")) {
        if (inList) { htmlParts.push("</ul>"); inList = false; }
        const title = this.escapeHtml(trimmed.slice(3));
        htmlParts.push(`
          <div class="j-theme-head" style="margin-top: 22px;">
            <div class="j-theme-tag"></div>
            <h3>${title}</h3>
          </div>
        `);
        continue;
      }

      if (trimmed.startsWith("_") && trimmed.endsWith("_")) {
        const meta = this.escapeHtml(trimmed.slice(1, -1));
        htmlParts.push(`<div class="j-theme-meta">${meta}</div>`);
        continue;
      }

      if (trimmed.startsWith("- ")) {
        if (!inList) {
          htmlParts.push('<ul class="j-bullet-list" style="margin: 6px 0 12px 18px; color: var(--muted); font-size: 13.5px; line-height: 1.7;">');
          inList = true;
        }
        const itemContent = this.formatInline(trimmed.slice(2));
        htmlParts.push(`<li>${itemContent}</li>`);
        continue;
      }

      if (inList) {
        htmlParts.push("</ul>");
        inList = false;
      }

      if (trimmed.startsWith("**") && (trimmed.endsWith("：**") || trimmed.endsWith(":**"))) {
        const sectionLabel = this.escapeHtml(trimmed.replace(/\*\*/g, "").replace(/[:：]/g, ""));
        htmlParts.push(`<div class="j-section-lbl" style="margin: 12px 0 4px; font-weight: 600; font-size: 13px; color: var(--accent);">${sectionLabel}：</div>`);
        continue;
      }

      htmlParts.push(`<p class="j-prose" style="margin: 6px 0; font-size: 13.5px; color: var(--text); line-height: 1.7;">${this.formatInline(trimmed)}</p>`);
    }

    if (inList) htmlParts.push("</ul>");
    return htmlParts.join("\n");
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  private formatInline(str: string): string {
    let res = this.escapeHtml(str);
    res = res.replace(/`([^`]+)`/g, '<code style="background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; font-family: var(--mono); font-size: 12px; color: var(--cyan);">$1</code>');
    res = res.replace(/\*\*([^*]+)\*\*/g, '<strong style="color: var(--text);">$1</strong>');
    res = res.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color: var(--accent); text-decoration: underline;">$1</a>');
    return res;
  }
}
