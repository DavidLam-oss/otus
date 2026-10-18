import { ActivityStore } from "./store.ts";
import type { ActivitySession } from "./store.ts";
import { defaultConfig, getLocalDateKey } from "./config.ts";
import type { OtusConfig } from "./config.ts";

const OTUS_NARRATIVE_SYSTEM_PROMPT = `你是一位极客程序员的专属个人折腾日记执笔人。你将根据用户电脑上的真实活动骨架数据，撰写一篇真实、有洞察、略带极客自嘲风格的第一人称「个人折腾日记」。

硬性规则（Hard rules）：
1. 语言要求（极其严格）：必须始终使用自然、凝练的简体中文撰写！严禁出现整段英文。
2. 视角与语调：
   - 采用第一人称视角（「我」或省略主语），语调像一名高段位独立开发者或极客在自己的独立博客记录当日手记。
   - 拒绝假大空的汇报官话，拒绝问候语或总结套话。
   - 偏好有力的动词：「搞定 / 连发三版 / 踩坑 / 闭环 / 优化 / 重构 / 砍掉」，少用「查看了 / 浏览了 / 打开了」。
3. 严格的事实边界：
   - 严禁编造任何未在骨架中出现的事实、PR 编号、版本号或项目名。所有 PR、版本号、Commit、人名必须原样保留。
4. 结构规范：
   - 保持一个一级标题（# YYYY-MM-DD 周X 个人折腾日记），每个核心主题一个二级标题（## 主题名）。
   - 保留骨架中的重点链接与行内代码块。
`;

const OTUS_INSIGHTS_SYSTEM_PROMPT = `你是一位敏锐的个人开发导师与效能分析专家。根据用户全天的活动骨架与统计数据，以犀利、具体、直击要害的口吻生成 4-6 条高质量的「工作流深度复盘与洞察」卡片。

请输出一个合法的 JSON 数组，每个卡片结构如下：
[
  {
    "type": "good" | "warn" | "ai",
    "tag": string,
    "title": string,
    "content": string
  }
]

说明：
- type: "good" (高光闭环、显著产出), "warn" (精力预警、过度调试、该改的), "ai" (多Agent编排、提示词优化、工程护栏沉淀)
- tag: 2-6字简短标签（如："高光闭环"、"精力预警"、"调试策略"、"AI工具习惯"、"工程护栏"、"产品化思维"）
- title: 简明有力（<= 25 字）
- content: 2-3 句具体剖析（<= 160 字），可使用 **粗体** 或 \`代码\` 标记关键点
`;

export interface ThemeCluster {
  key: string;
  project: string | null;
  sessions: { row: ActivitySession; ocrSnippets: string[]; browserVisits: any[]; windowTitles: string[] }[];
  entities: Record<string, any[]>;
  topics: string[];
  totalMs: number;
}

export class ActivitySummarizer {
  private store: ActivityStore;
  private config: OtusConfig;

  constructor(store: ActivityStore, config: Partial<OtusConfig> = {}) {
    this.store = store;
    this.config = { ...defaultConfig, ...config };
  }

  public async generateDailyReport(
    dateKey?: string,
    opts: { force?: boolean; skeletonOnly?: boolean } = {}
  ): Promise<{
    dateKey: string;
    markdown: string;
    skeleton: string;
    isPartial: boolean;
    stats: Record<string, any>;
    insights: Array<{ type: string; tag: string; title: string; content: string }>;
    generatedAt: number;
  }> {
    const today = getLocalDateKey();
    const targetDate = dateKey || today;
    const isToday = targetDate === today;

    // 1. 缓存检查
    if (!opts.force) {
      const existing = this.store.getSummary("daily", targetDate);
      if (existing && existing.stats && typeof existing.stats.report === "string") {
        if (!(isToday && Date.now() - (existing.stats.reportGeneratedAt || existing.updatedAt) > 600000)) {
          return {
            dateKey: targetDate,
            markdown: existing.stats.report,
            skeleton: existing.stats.skeleton || existing.stats.report,
            isPartial: existing.isPartial,
            stats: existing.stats.reportStats || {},
            insights: existing.stats.insights || [],
            generatedAt: existing.stats.reportGeneratedAt || existing.updatedAt
          };
        }
      }
    }

    // 2. 提取当天的所有会话
    const [year, month, day] = targetDate.split("-").map(Number);
    const startOfDay = new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
    const endOfDay = new Date(year, month - 1, day + 1, 0, 0, 0, 0).getTime();

    const allSessions = this.store.listSessions({ since: startOfDay, until: endOfDay, limit: 1000 });
    const analyzedSessions = allSessions.filter((s) => {
      if (s.analysisStatus !== "analyzed" || !s.analysisTitle) return false;
      const app = (s.appNames[0] || "").toLowerCase();
      if (["loginwindow", "screensaverengine", "lockscreen", "screensaver"].includes(app)) return false;
      const title = (s.analysisTitle || "").toLowerCase();
      if (title.startsWith("loginwindow") || title.startsWith("idle /") || title.includes("系统锁屏闲置")) return false;
      return true;
    });
    const filteredSessions = allSessions.filter((s) => s.analysisStatus === "not_worth" || !analyzedSessions.includes(s));

    // 提取会话的抽稀上下文
    const enriched = analyzedSessions.map((sess) => {
      const ocrs = this.store.listOcrForSession(sess.id, 12);
      const ocrSnippets: string[] = [];
      let lastText = "";
      for (const o of ocrs) {
        const c = o.text.replace(/\s+/g, " ").trim();
        if (c && c !== lastText) {
          lastText = c;
          ocrSnippets.push(c.slice(0, 400));
          if (ocrSnippets.length >= 6) break;
        }
      }

      const events = this.store.listEvents(sess.id, 200);
      const browserVisits: any[] = [];
      const seenUrls = new Set<string>();
      for (const ev of events) {
        if (ev.kind === "browser_visit" && ev.data?.url && !seenUrls.has(ev.data.url)) {
          seenUrls.add(ev.data.url);
          browserVisits.push({ url: ev.data.url, title: ev.data.title || "" });
          if (browserVisits.length >= 40) break;
        }
      }

      return { row: sess, ocrSnippets, browserVisits, windowTitles: [] };
    });

    // 3. 统计全天活跃时长与主用应用
    let totalActiveMs = 0;
    const appDurations = new Map<string, number>();
    for (const sess of allSessions) {
      totalActiveMs += sess.durationMs || 0;
      const perApp = this.store.perAppDurationsForSession(sess.id);
      for (const [app, ms] of perApp.entries()) {
        appDurations.set(app, (appDurations.get(app) || 0) + ms);
      }
    }

    const topApps = [...appDurations.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([app, ms]) => ({ app, minutes: Math.round(ms / 60000) }));

    // 4. 执行 Jaccard 相似度聚类
    const clusters = this.clusterSessions(enriched);

    const reportStats = {
      sessionCount: allSessions.length,
      analyzedCount: analyzedSessions.length,
      filteredCount: filteredSessions.length,
      totalActiveMinutes: Math.round(totalActiveMs / 60000),
      clusterCount: clusters.length,
      topApps
    };

    if (clusters.length === 0) {
      const emptyMd = `# ${targetDate} 个人折腾日记\n\n今天没有可分析的活动记录。`;
      this.store.upsertSummary({
        kind: "daily",
        dateKey: targetDate,
        summary: emptyMd,
        stats: { report: emptyMd, skeleton: emptyMd, insights: [], reportGeneratedAt: Date.now(), reportStats },
        isPartial: isToday
      });
      return {
        dateKey: targetDate,
        markdown: emptyMd,
        skeleton: emptyMd,
        isPartial: isToday,
        stats: reportStats,
        insights: [],
        generatedAt: Date.now()
      };
    }

    // 5. 拼装结构化 Markdown 骨架
    const skeleton = this.buildSkeleton(clusters, targetDate, reportStats);

    // 6. 生成复盘与洞察卡片 (LLM 深度反思 + 启发式兜底)
    const insights = await this.generateReviewInsights(skeleton, reportStats);

    if (opts.skeletonOnly || !this.config.llmApiKey) {
      this.store.upsertSummary({
        kind: "daily",
        dateKey: targetDate,
        summary: skeleton.split("\n").find((l) => l.trim() && !l.startsWith("#")) || null,
        stats: { report: skeleton, skeleton, insights, reportGeneratedAt: Date.now(), reportStats },
        isPartial: isToday
      });
      return {
        dateKey: targetDate,
        markdown: skeleton,
        skeleton,
        isPartial: isToday,
        stats: reportStats,
        insights,
        generatedAt: Date.now()
      };
    }

    // 7. 调用 Narrative Pass 进行第一人称润色
    let finalMarkdown = skeleton;
    let modelUsed: string | null = null;
    try {
      const polished = await this.narrativePass(skeleton);
      if (polished && polished.length > 80) {
        finalMarkdown = polished;
        modelUsed = this.config.reportModel;
      }
    } catch (err) {
      console.error("[ActivitySummarizer] Narrative pass failed, falling back to skeleton:", err);
    }

    const firstSummarySentence = finalMarkdown
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#")) || null;

    this.store.upsertSummary({
      kind: "daily",
      dateKey: targetDate,
      summary: firstSummarySentence,
      stats: { report: finalMarkdown, skeleton, insights, reportGeneratedAt: Date.now(), reportStats },
      model: modelUsed,
      isPartial: isToday
    });

    return {
      dateKey: targetDate,
      markdown: finalMarkdown,
      skeleton,
      isPartial: isToday,
      stats: reportStats,
      insights,
      generatedAt: Date.now()
    };
  }

  // 原生 Jaccard 相似度聚类算法
  private clusterSessions(sessions: any[]): ThemeCluster[] {
    const sorted = [...sessions].sort((a, b) => a.row.startedAt - b.row.startedAt);
    const clusters: ThemeCluster[] = [];

    for (const item of sorted) {
      const tokens = this.extractTokens(item);

      // 若有显式 project
      if (item.row.project) {
        const key = `proj:${item.row.project.toLowerCase()}`;
        const existing = clusters.find((c) => c.key === key);
        if (existing) {
          existing.sessions.push(item);
          this.mergeEntities(existing.entities, item.row.entities);
          for (const t of item.row.topics || []) {
            if (!existing.topics.includes(t)) existing.topics.push(t);
          }
          existing.totalMs += item.row.durationMs || 0;
          continue;
        }
        clusters.push(this.newCluster(key, item));
        continue;
      }

      // 无显式 project，计算 Jaccard 相似度
      let bestCluster: ThemeCluster | null = null;
      let maxSim = 0;
      for (const c of clusters) {
        const cTokens = this.clusterTokens(c);
        const sim = this.jaccard(tokens, cTokens);
        if (sim > maxSim) {
          maxSim = sim;
          bestCluster = c;
        }
      }

      if (bestCluster && maxSim >= 0.18) {
        bestCluster.sessions.push(item);
        this.mergeEntities(bestCluster.entities, item.row.entities);
        for (const t of item.row.topics || []) {
          if (!bestCluster.topics.includes(t)) bestCluster.topics.push(t);
        }
        bestCluster.totalMs += item.row.durationMs || 0;
      } else {
        clusters.push(this.newCluster(`sess:${item.row.id}`, item));
      }
    }

    // 细小碎片折叠进 misc
    const mainClusters: ThemeCluster[] = [];
    const miscCandidates: ThemeCluster[] = [];
    for (const c of clusters) {
      const hasArtifacts =
        (c.entities.prs?.length ?? 0) +
        (c.entities.issues?.length ?? 0) +
        (c.entities.decisions?.length ?? 0) > 0;
      if (c.sessions.length === 1 && c.totalMs < 180000 && !hasArtifacts) {
        miscCandidates.push(c);
      } else {
        mainClusters.push(c);
      }
    }

    if (miscCandidates.length <= 1) {
      return [...mainClusters, ...miscCandidates];
    }

    const miscCluster: ThemeCluster = {
      key: "misc",
      project: null,
      sessions: [],
      entities: {},
      topics: [],
      totalMs: 0
    };
    for (const c of miscCandidates) {
      miscCluster.sessions.push(...c.sessions);
      this.mergeEntities(miscCluster.entities, c.entities);
      for (const t of c.topics) {
        if (!miscCluster.topics.includes(t)) miscCluster.topics.push(t);
      }
      miscCluster.totalMs += c.totalMs;
    }

    return [...mainClusters, miscCluster];
  }

  private newCluster(key: string, item: any): ThemeCluster {
    const entities: Record<string, any[]> = {};
    this.mergeEntities(entities, item.row.entities);
    return {
      key,
      project: item.row.project || null,
      sessions: [item],
      entities,
      topics: [...(item.row.topics || [])],
      totalMs: item.row.durationMs || 0
    };
  }

  private extractTokens(item: any): Set<string> {
    const set = new Set<string>();
    if (item.row.project) set.add(`proj:${item.row.project.toLowerCase()}`);
    for (const t of item.row.topics || []) set.add(`topic:${t.toLowerCase()}`);
    const e = item.row.entities || {};
    for (const pr of e.prs || []) if (pr.label || pr.ref) set.add(`pr:${pr.label || pr.ref}`);
    for (const iss of e.issues || []) if (iss.label || iss.ref) set.add(`iss:${iss.label || iss.ref}`);
    for (const c of e.commits || []) if (c.label || c.ref) set.add(`commit:${c.label || c.ref}`);
    for (const p of e.people || []) if (p.handle) set.add(`person:${p.handle}`);
    for (const id of e.identifiers || []) set.add(`id:${id.toLowerCase()}`);
    return set;
  }

  private clusterTokens(c: ThemeCluster): Set<string> {
    const set = new Set<string>();
    if (c.project) set.add(`proj:${c.project.toLowerCase()}`);
    for (const t of c.topics) set.add(`topic:${t.toLowerCase()}`);
    for (const pr of c.entities.prs || []) if (pr.label || pr.ref) set.add(`pr:${pr.label || pr.ref}`);
    for (const iss of c.entities.issues || []) if (iss.label || iss.ref) set.add(`iss:${iss.label || iss.ref}`);
    for (const cmt of c.entities.commits || []) if (cmt.label || cmt.ref) set.add(`commit:${cmt.label || cmt.ref}`);
    for (const p of c.entities.people || []) if (p.handle) set.add(`person:${p.handle}`);
    for (const id of c.entities.identifiers || []) set.add(`id:${String(id).toLowerCase()}`);
    return set;
  }

  private jaccard(a: Set<string>, b: Set<string>): number {
    if (!a.size || !b.size) return 0;
    let intersection = 0;
    for (const item of a) {
      if (b.has(item)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  private mergeEntities(target: Record<string, any[]>, source: Record<string, any[]>): void {
    if (!source) return;
    for (const [key, list] of Object.entries(source)) {
      if (!Array.isArray(list)) continue;
      if (!target[key]) target[key] = [];
      for (const item of list) {
        const str = JSON.stringify(item);
        if (!target[key].some((ex) => JSON.stringify(ex) === str)) {
          target[key].push(item);
        }
      }
    }
  }

  // 原生 Markdown 骨架生成器
  private buildSkeleton(clusters: ThemeCluster[], dateKey: string, stats: any): string {
    const [year, month, day] = dateKey.split("-").map(Number);
    const dayOfWeek = ["日", "一", "二", "三", "四", "五", "六"][new Date(year, month - 1, day).getDay()];
    const lines: string[] = [];

    lines.push(`# ${dateKey} 周${dayOfWeek} 个人折腾日记`);
    lines.push("");
    const topAppsStr = stats.topApps.length
      ? ` 主用：${stats.topApps.map((a: any) => `${a.app} (${a.minutes}m)`).join("、")}。`
      : "";
    const filteredStr = stats.filteredCount > 0 ? `，${stats.filteredCount} 个闲置已过滤` : "";
    lines.push(
      `活跃 ${stats.totalActiveMinutes} 分钟，共 ${stats.sessionCount} 个 session（${stats.analyzedCount} 个实质折腾${filteredStr}），归类为 ${stats.clusterCount} 个核心主题。${topAppsStr}`
    );
    lines.push("");

    // 按重要度排序：有 PR/Issue 的优先，其次按总时长降序
    const sorted = [...clusters].sort((a, b) => {
      const aArtifacts = (a.entities.prs?.length ?? 0) + (a.entities.issues?.length ?? 0);
      const bArtifacts = (b.entities.prs?.length ?? 0) + (b.entities.issues?.length ?? 0);
      if (aArtifacts !== bArtifacts) return bArtifacts - aArtifacts;
      return b.totalMs - a.totalMs;
    });

    for (const c of sorted) {
      const themeTitle = c.key === "misc" ? "其他零碎" : c.project || c.topics[0] || c.sessions[0]?.row.analysisTitle || "日常专注";
      const totalMin = Math.round(c.totalMs / 60000);
      const sessCount = c.sessions.length;

      lines.push(`## ${themeTitle}`);
      lines.push(`_${totalMin} 分钟 · ${sessCount} 个 session_`);
      lines.push("");

      // highlights
      const highlights: string[] = [];
      for (const s of c.sessions) {
        for (const h of s.row.highlights || []) {
          if (!highlights.includes(h)) highlights.push(h);
        }
      }
      if (highlights.length) {
        lines.push("**做了什么：**");
        for (const h of highlights.slice(0, 6)) {
          lines.push(`- ${h}`);
        }
        lines.push("");
      }

      // 关键信息 (Entities)
      const entityLines = this.formatEntities(c.entities);
      if (entityLines) {
        lines.push("**关键信息：**");
        lines.push(entityLines);
        lines.push("");
      }

      // 时间线 (Timeline)
      lines.push("**时间线：**");
      for (const s of c.sessions) {
        const d = new Date(s.row.startedAt);
        const timeStr = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        const minStr = Math.max(1, Math.round((s.row.durationMs || 0) / 60000));
        const title = s.row.analysisTitle || "(未分析)";
        lines.push(`- ${timeStr} · ${minStr}m — ${title}`);
        if (s.row.analysisDescription) {
          lines.push(`  ${s.row.analysisDescription.slice(0, 240)}`);
        }
      }
      lines.push("");
    }

    return lines.join("\n").trim();
  }

  private formatEntities(e: Record<string, any[]>): string {
    const parts: string[] = [];
    if (e.prs?.length) {
      parts.push(`- **PRs**: ${e.prs.map((p) => p.url ? `[${p.label}](${p.url})` : p.label).join("、")}`);
    }
    if (e.issues?.length) {
      parts.push(`- **Issues**: ${e.issues.map((i) => i.url ? `[${i.label}](${i.url})` : i.label).join("、")}`);
    }
    if (e.commits?.length) {
      parts.push(`- **Commits**: ${e.commits.map((c) => c.label).join("、")}`);
    }
    if (e.people?.length) {
      parts.push(`- **人**: ${e.people.map((p) => p.name ? `${p.name} (${p.handle})` : p.handle).join("、")}`);
    }
    if (e.versions?.length) {
      parts.push(`- **版本**: ${e.versions.map((v) => `\`${v}\``).join("、")}`);
    }
    if (e.identifiers?.length) {
      parts.push(`- **关键标识**: ${e.identifiers.slice(0, 12).map((id) => `\`${id}\``).join("、")}`);
    }
    if (e.decisions?.length) {
      parts.push(`- **决定/产出**:\n  - ${e.decisions.join("\n  - ")}`);
    }
    return parts.join("\n");
  }

  private async narrativePass(skeleton: string): Promise<string> {
    const url = `${this.config.llmApiBase.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.llmApiKey) headers["Authorization"] = `Bearer ${this.config.llmApiKey}`;

    let lastError: any;
    for (let attempt = 0; attempt <= 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);

      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: this.config.reportModel,
            messages: [
              { role: "system", content: OTUS_NARRATIVE_SYSTEM_PROMPT },
              {
                role: "user",
                content: `Here is the structured skeleton. Rewrite it into the final journal, following all rules.\n\n${skeleton}`
              }
            ],
            temperature: 0.3
          })
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Narrative pass HTTP ${res.status}: ${errText}`);
        }

        const data = await res.json() as any;
        return data.choices?.[0]?.message?.content?.trim() || "";
      } catch (err: any) {
        lastError = err;
        const msg = String(err?.message || err);
        const isQuotaExhausted =
          msg.toLowerCase().includes("credits exhausted") ||
          msg.toLowerCase().includes("insufficient_quota") ||
          msg.toLowerCase().includes("quota exceeded");

        const isRetryable =
          !isQuotaExhausted &&
          (msg.includes("429") ||
            msg.toLowerCase().includes("rate limit") ||
            msg.includes("500") ||
            msg.includes("502") ||
            msg.includes("503") ||
            msg.includes("fetch failed"));

        if (attempt < 2 && isRetryable) {
          const backoff = 2000 * Math.pow(2, attempt);
          console.warn(`[ActivitySummarizer] Narrative pass attempt ${attempt + 1} failed (${msg.slice(0, 100)}). Retrying in ${backoff}ms...`);
          await new Promise((r) => setTimeout(r, backoff));
        } else {
          break;
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  public async generateReviewInsights(
    skeleton: string,
    stats: any
  ): Promise<Array<{ type: string; tag: string; title: string; content: string }>> {
    const url = `${this.config.llmApiBase.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.llmApiKey) headers["Authorization"] = `Bearer ${this.config.llmApiKey}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: this.config.reportModel,
            messages: [
              { role: "system", content: OTUS_INSIGHTS_SYSTEM_PROMPT },
              {
                role: "user",
                content: `今日全天数据：活跃时长 ${stats.totalActiveMinutes} 分钟，会话数 ${stats.sessionCount}，有效分析 ${stats.analyzedCount}，主用应用：${JSON.stringify(stats.topApps)}。\n\n活动骨架：\n${skeleton.slice(0, 3000)}`
              }
            ],
            temperature: 0.2
          })
        });

        if (res.ok) {
          const data = (await res.json()) as any;
          const text = data.choices?.[0]?.message?.content || "";
          const match = text.match(/\[[\s\S]*\]/) || text.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            const list = Array.isArray(parsed) ? parsed : parsed.insights || parsed.cards || [];
            if (Array.isArray(list) && list.length > 0) {
              return list.map((item: any) => ({
                type: ["good", "warn", "ai"].includes(item.type) ? item.type : "good",
                tag: String(item.tag || "复盘洞察"),
                title: String(item.title || "今日工作流"),
                content: String(item.content || "")
              }));
            }
          }
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      console.warn("[ActivitySummarizer] LLM insights generation failed, using heuristic fallback:", err);
    }

    // 启发式高质量洞察兜底（对齐 Alma 风格）
    const fallback: Array<{ type: string; tag: string; title: string; content: string }> = [];
    const topApp = stats.topApps?.[0]?.app || "代码编辑器";
    const topAppMins = stats.topApps?.[0]?.minutes || 0;

    fallback.push({
      type: "good",
      tag: "主攻聚焦",
      title: `全天重度深耕 ${topApp}`,
      content: `今日在 **${topApp}** 累计投入超 ${topAppMins} 分钟，完成了 ${stats.analyzedCount || 0} 个有效推进会话，形成了明确的开发闭环。`
    });

    if (stats.totalActiveMinutes >= 480) {
      fallback.push({
        type: "warn",
        tag: "精力预警",
        title: `连轴运转超 ${Math.round(stats.totalActiveMinutes / 60)} 小时`,
        content: `全天累计活跃专注时长达 **${stats.totalActiveMinutes} 分钟**，持续高强度注意力容易导致晚间认知负荷过载，建议设定强制屏幕休息窗口。`
      });
    } else {
      fallback.push({
        type: "good",
        tag: "心流节奏",
        title: "专注节奏紧凑高效",
        content: `有效折腾会话 ${stats.analyzedCount} 个，系统已自动剔除 ${stats.filteredCount || 0} 个无操作闲置切片，折腾信噪比保持高位。`
      });
    }

    fallback.push({
      type: "ai",
      tag: "工程护栏",
      title: "踩坑即固化，打造自动化护栏",
      content: `在开发与调试流程中，保持将高频试错与边界条件固化为脚本、类型规范与规则文档，这是复利最高的技术资产。`
    });

    return fallback;
  }
}
