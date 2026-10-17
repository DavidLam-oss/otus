import { ActivityStore } from "./store.ts";
import type { ActivitySession } from "./store.ts";
import { defaultConfig } from "./config.ts";
import type { OtusConfig } from "./config.ts";

const OTUS_NARRATIVE_SYSTEM_PROMPT = `You are writing a first-person personal tinkering & dev journal (个人折腾日记) for the user, based on a structured activity skeleton they give you. Note: this is on the user's personal computer for personal exploration, coding, learning and tinkering (NOT a corporate employee work report).

Hard rules:
- Write in the same language the skeleton is in (日本語 / 中文 / English). Mirror the user's voice — terse, concrete, a little wry, personal dev log style. Do not add greetings or meta commentary.
- NEVER invent facts. Every PR number, person handle, version, identifier, URL, and decision in your output must come verbatim from the skeleton. If something isn't in the skeleton, do not add it.
- Keep the markdown structure: one top-level "# " heading (e.g. "# YYYY-MM-DD 周X 个人折腾日记"), one "## " per theme, bullets for artifacts. But feel free to tighten wording, merge redundant bullets, and add 1-2 sentences of connective prose under each heading.
- Preserve every markdown link and code-span the skeleton provides — do not rewrite [label](url) as plain text.
- Prefer "shipped / decided / built / explored / fixed / tuned" over "looked at / browsed / opened". If the skeleton only has vague activity with no PR/decision/version, keep it a single short line — don't pad.
- Drop the "时间线" / "Timeline" bullets in your output unless they add information the theme-level summary loses. The journal is about what got done, not what minute it happened.
- Order themes by importance (features/bugs/decisions first, detours last). Keep "其他零碎" / "Misc" at the end.
- Total length budget: ~500-900 words for a normal day. Don't pad.`;

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
    generatedAt: number;
  }> {
    const today = new Date().toISOString().slice(0, 10);
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
    const analyzedSessions = allSessions.filter((s) => s.analysisStatus === "analyzed" && s.analysisTitle);

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
        stats: { report: emptyMd, skeleton: emptyMd, reportGeneratedAt: Date.now(), reportStats },
        isPartial: isToday
      });
      return {
        dateKey: targetDate,
        markdown: emptyMd,
        skeleton: emptyMd,
        isPartial: isToday,
        stats: reportStats,
        generatedAt: Date.now()
      };
    }

    // 5. 拼装结构化 Markdown 骨架
    const skeleton = this.buildSkeleton(clusters, targetDate, reportStats);

    if (opts.skeletonOnly || !this.config.llmApiKey) {
      this.store.upsertSummary({
        kind: "daily",
        dateKey: targetDate,
        summary: skeleton.split("\n").find((l) => l.trim() && !l.startsWith("#")) || null,
        stats: { report: skeleton, skeleton, reportGeneratedAt: Date.now(), reportStats },
        isPartial: isToday
      });
      return {
        dateKey: targetDate,
        markdown: skeleton,
        skeleton,
        isPartial: isToday,
        stats: reportStats,
        generatedAt: Date.now()
      };
    }

    // 6. 调用 Narrative Pass 进行第一人称润色
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
      stats: { report: finalMarkdown, skeleton, reportGeneratedAt: Date.now(), reportStats },
      model: modelUsed,
      isPartial: isToday
    });

    return {
      dateKey: targetDate,
      markdown: finalMarkdown,
      skeleton,
      isPartial: isToday,
      stats: reportStats,
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
    lines.push(
      `活跃 ${stats.totalActiveMinutes} 分钟，共 ${stats.sessionCount} 个 session（已分析 ${stats.analyzedCount}），分到 ${stats.clusterCount} 个主题。${topAppsStr}`
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

    const res = await fetch(url, {
      method: "POST",
      headers,
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
      throw new Error(`Narrative pass HTTP ${res.status}`);
    }

    const data = await res.json() as any;
    return data.choices?.[0]?.message?.content?.trim() || "";
  }
}
