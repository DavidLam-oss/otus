import { ActivityStore } from "./store.ts";
import type { ActivitySession } from "./store.ts";
import { defaultConfig, getLocalDateKey } from "./config.ts";
import type { OtusConfig } from "./config.ts";
import { tokenize, tfidf, cosine, hacCluster, mmrSelect } from "./math-utils.ts";
import { redactSensitiveText } from "./redactor.ts";

const OTUS_NARRATIVE_SYSTEM_PROMPT = `你是一位极客程序员的专属个人折腾日记执笔人。你将根据用户电脑上的真实活动骨架数据，撰写一篇真实、有洞察、略带极客自嘲风格的第一人称「个人折腾日记」。

硬性规则（Hard rules）：
1. 语言要求（极其严格）：必须始终使用自然、凝练的简体中文撰写！严禁出现整段英文。
2. 视角与语调：
   - 采用第一人称视角（「我」或省略主语），语调像一名高段位独立开发者或极客在自己的独立博客记录当日手记。
   - 拒绝假大空的汇报官话，拒绝问候语或总结套话。
   - 偏好有力的动词：「搞定 / 连发三版 / 踩坑 / 闭环 / 优化 / 重构 / 砍掉」，少用「查看了 / 浏览了 / 打开了」。
3. 严格的事实边界：
   - 严禁编造任何未在骨架中出现的事实、PR 编号、版本号或项目名。所有 PR、版本号、Commit、人名必须原样保留。
   - 严禁改写任何数字（分钟数、session 数、百分比、版本号），必须与骨架完全一致。
   - 严禁新增骨架中不存在的 URL；骨架中的链接必须保留。
4. 结构规范：
   - **不要输出一级标题（# 开头的那一行）**，它由程序自动生成，你输出的内容会直接拼在它下面。
   - 保持每个核心主题一个二级标题（## 主题名），标题下的「_X 分钟 · Y 个 session_」统计行必须保留。
   - 保留骨架中的重点链接与行内代码块。
   - 输出开头不要有任何前言、说明或代码块标记。
`;

const OTUS_THEME_SYSTEM_PROMPT = `你是活动记录的全局主题归纳器。你会收到某一天全部会话的清单，
每条包含：编号、时间、时长、使用过的 App、分析标题；
部分会话还会带有简短摘要（summary）、话题标签（topics）、以及高信号条目（signals，
如涉及的文件/代码行、做出的关键决策）。缺失的字段表示该会话没有更多可用信息。

你的任务是三件事：
(A) 把这些会话归并成若干个「核心主题」，并给每个主题起一个简短名字。
(B) 修正每条会话的标题（title）——单条标题是由只看到这一段活动的模型生成的，
    经常被侧边栏/历史列表里出现的项目名带偏，需要你结合前后文纠正。
(C) 为每个主题写一段「当日叙述」（narrative）——用一段连贯的话，
    说清当天这个主题实际做了哪几件事、走了什么过程，像日记一样自然。

判定原则（按优先级）：
1. **看前后文，不看单个会话**。同一段时间连续做同一类事，即使单条标题措辞不同，也应归为同一主题。
2. 判断依据是「实际在产出什么」，不是「打开了哪个 App」，
   也不是「侧边栏/历史列表里出现了什么」。
   例：用 Obsidian 和 WorkBuddy 写关于某产品的公众号文章 → 主题是「写公众号文章」，
   即使侧边栏里出现过别的项目名，也不代表在改那个项目的代码。
3. 只有当会话里**明确出现该项目的产物**（该仓库的 Issue/PR、代码文件、构建命令、git 操作）
   才可以把主题或标题命名为该项目的名字。
4. 应用侧边栏、工作区列表、历史任务标题里出现的项目名，**不能**作为命名依据。
   （这是最常见的误判来源：用户在 A 应用里做某件事，A 的侧边栏恰好列出 B 项目，
   模型就把这条会话说成「在搞 B」。）
5. 主题数量控制在 3~12 个之间。宁可少而准，不要多而碎。
6. 时间上明显分散、内容也无关的活动，应分到不同主题。

关于「当日叙述」(C) 的要求：
- 用**一段连贯的话**（不是分条 bullet），像日记一样把这件事的来龙去脉讲清楚。
- 同一件事的不同侧面要合在一起讲（例如「注册 Webhook」「删旧 Webhook」「改注册脚本域名」
  「Webhook 随 push 生效」都是同一件事，应合并成一句叙述，而不是分开罗列）。
- **有多少说多少，不要为凑字数硬写**：如果这个主题只发生了一件事，就一两句话讲完，
  不要编造细节、不要凑长度。
- 具体但不啰嗦：带上关键对象名、数字（如「修通 License.ts 字段名 Bug」「225 BPM」），
  但**不要罗列所有细节**——细节留在数据库里，报告只做概览回顾。
- 用自然的书面语，不用「在 XX 中做 YY」这种把 App 当主语的句式。

输出格式（严格 JSON，不要任何解释文字）：
{
  "themes": [
    {
      "name": "主题名（<= 16 字，具体而非空泛）",
      "sessionIds": ["s0", "s3", "s7"],
      "narrative": "这个主题当天做了什么的一段连贯叙述（<= 150 字，自然口语，不凑字数）"
    }
  ],
  "titles": [
    { "id": "s0", "title": "修正后的标题（<= 20 字，直述实际做了什么）" }
  ]
}

要求：
- 每个会话编号必须且只能出现在一个主题里，不得遗漏、不得重复。
- 只能使用输入中出现过的会话编号。
- titles 里请为**每一条**会话都给出修正标题；若原标题已准确，可原样返回。
- 标题要直述实际产出（如「与 AI 排查菜单栏崩溃并修复」），
  不要写「在 XX 中做 YY」这种把 App 当主语的句式。

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
  // LLM 全局归纳给出的主题名；为空时回退到 project/topics 推导
  displayName?: string;
  // LLM 全局归纳提炼的主题主线（2~4 条），用于报告概览；为空时回退到 highlights
  themeLines?: string[];
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

    // 1. 缓存与增量活跃判定 (Activity-Driven Cache)
    if (!opts.force) {
      const existing = this.store.getSummary("daily", targetDate);
      if (existing && existing.stats && typeof existing.stats.report === "string") {
        if (!isToday) {
          // 历史日期（如昨日）：已有总结直接秒开返回，绝不重复调用大模型
          // isPartial 必须重算：报告可能是当天生成的（当时 isToday=true 被固化为 partial），
          // 但到了次日它就是完整的历史报告，不能再标记为「进行中」。
          const settledPartial = false;
          if (existing.isPartial !== settledPartial) {
            this.store.upsertSummary({
              kind: "daily",
              dateKey: targetDate,
              summary: existing.summary,
              stats: existing.stats,
              model: existing.model,
              isPartial: settledPartial
            });
          }
          return {
            dateKey: targetDate,
            markdown: existing.stats.report,
            skeleton: existing.stats.skeleton || existing.stats.report,
            isPartial: settledPartial,
            stats: existing.stats.reportStats || {},
            insights: existing.stats.insights || [],
            generatedAt: existing.stats.reportGeneratedAt || existing.updatedAt
          };
        }

        // 今日报告判定：
        const lastGeneratedAt = existing.stats.reportGeneratedAt || existing.updatedAt || 0;
        const elapsedMs = Date.now() - lastGeneratedAt;
        const newSessions = this.store.countAnalyzedSessionsSince(lastGeneratedAt);

        // 最佳实践：
        // a. 若自上次生成以来没有任何新的已分析会话产生，100% 复用缓存，避免死板时间过期浪费 Token
        // b. 若有新会话产生，但处于 30 分钟冷静期内，依然复用缓存，保障日间频繁查看时的毫秒级秒开
        if (newSessions === 0 || elapsedMs < 30 * 60 * 1000) {
          return {
            dateKey: targetDate,
            markdown: existing.stats.report,
            skeleton: existing.stats.skeleton || existing.stats.report,
            isPartial: existing.isPartial,
            stats: existing.stats.reportStats || {},
            insights: existing.stats.insights || [],
            generatedAt: lastGeneratedAt
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
    let earliestStart = Number.POSITIVE_INFINITY;
    let latestEnd = 0;
    const appDurations = new Map<string, number>();
    for (const sess of allSessions) {
      totalActiveMs += sess.durationMs || 0;
      // 墙钟跨度：从最早会话开始到最晚会话结束
      const start = sess.startedAt;
      const end = sess.endedAt || (sess.startedAt + (sess.durationMs || 0));
      if (start > 0) earliestStart = Math.min(earliestStart, start);
      if (end > 0) latestEnd = Math.max(latestEnd, end);
      const perApp = this.store.perAppDurationsForSession(sess.id);
      for (const [app, ms] of perApp.entries()) {
        appDurations.set(app, (appDurations.get(app) || 0) + ms);
      }
    }

    // 墙钟跨度与利用率：帮助用户理解「活跃 N 分钟」是有效时长而非在职时长
    const wallClockMs =
      Number.isFinite(earliestStart) && latestEnd > earliestStart ? latestEnd - earliestStart : 0;
    const utilizationPct = wallClockMs > 0 ? Math.round((totalActiveMs / wallClockMs) * 100) : 0;
    const wallClockHours = Math.round((wallClockMs / 3600000) * 10) / 10;

    const topApps = [...appDurations.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([app, ms]) => ({ app, minutes: Math.round(ms / 60000) }));

    // 4. 主题聚类
    // 优先让 LLM 做全局归纳（能看到完整时间线，判断更准）；
    // 失败或未配置 LLM 时回退到本地 Jaccard 聚类。
    const globalClusters = await this.generateGlobalThemes(enriched, targetDate).catch((err) => {
      console.warn("[ActivitySummarizer] 全局主题归纳异常，回退本地聚类:", err);
      return null;
    });
    const clusters = globalClusters ?? this.clusterSessions(enriched);

    const reportStats = {
      sessionCount: allSessions.length,
      analyzedCount: analyzedSessions.length,
      filteredCount: filteredSessions.length,
      totalActiveMinutes: Math.round(totalActiveMs / 60000),
      wallClockHours,
      utilizationPct,
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

    const reportApiBase = this.config.reportApiBase || this.config.llmApiBase;
    const reportApiKey = this.config.reportApiKey !== undefined ? this.config.reportApiKey : this.config.llmApiKey;
    const hasReportLlm = !!reportApiKey || reportApiBase.includes("localhost") || reportApiBase.includes("127.0.0.1");

    if (opts.skeletonOnly || !hasReportLlm) {
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
    //
    // 关键设计：只把「主题正文」交给 LLM，一级标题与统计行由代码生成后再拼回。
    // 这样即使 LLM 改坏文风，也动不到日期和统计事实，属于结构性防护。
    // 在其之上再叠加 validateNarrative() 作为兜底（防止正文里编造链接/编号）。
    const headerLines = this.buildSkeletonHeader(targetDate, reportStats);
    const bodySkeleton = skeleton.slice(headerLines.join("\n").length).replace(/^\n+/, "");

    let finalMarkdown = skeleton;
    let modelUsed: string | null = null;
    try {
      const polished = await this.narrativePass(bodySkeleton, targetDate);
      if (polished && polished.length > 80) {
        // 校验对象是「拼回头部后的完整报告」，确保与最终产物一致
        const assembled = [...headerLines, polished].join("\n").trim();
        const verdict = this.validateNarrative(skeleton, assembled, targetDate);
        if (verdict.ok) {
          finalMarkdown = assembled;
          modelUsed = this.config.reportModel;
        } else {
          console.warn(
            `[ActivitySummarizer] 润色结果未通过事实校验，已回退到骨架。问题：${verdict.reasons.join("；")}`
          );
        }
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

  /** 从模型回复中提取 JSON（容忍前后多余文字、代码块围栏） */
  private cleanAndParseJSON(raw: string): any {
    try {
      const trimmed = String(raw || "").trim();
      // 去掉 ```json ... ``` 围栏
      const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
      const body = fenced ? fenced[1] : trimmed;
      const match = body.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  /**
   * 从单会话分析产出的 entities 中挑选高信号条目（identifiers / decisions），
   * 供全局主题归纳使用。去重、截断、限量：合计最多 5 条，每条 ≤40 字。
   * 多数会话 entities 很稀疏（实测平均 identifiers 1.1 条、decisions 0.1 条），
   * 因此有则取、无则返回空数组，绝不硬凑。
   */
  private pickHighSignalEntities(entities: any): string[] {
    if (!entities || typeof entities !== "object") return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (v: any) => {
      if (out.length >= 5) return;
      if (v === null || v === undefined) return;
      const s = String(v).replace(/\s+/g, " ").trim();
      if (!s || s.length > 40 || seen.has(s)) return;
      seen.add(s);
      out.push(s);
    };
    // identifiers 通常是文件/代码行/变量名这类最精确的信号，优先。
    if (Array.isArray(entities.identifiers)) {
      for (const v of entities.identifiers) push(v);
    }
    // decisions 是"做了什么决策"，对主题归纳很有价值。
    if (Array.isArray(entities.decisions)) {
      for (const v of entities.decisions) push(v);
    }
    return out;
  }

  /**
   * 全局主题归纳：把全天会话交给 LLM 一次性归并成主题。
   *
   * 为什么放在报告阶段而不是分析阶段：
   *   分析阶段每个会话只看到自己那 3-7 分钟，看不到前后文，
   *   只能从侧边栏猜项目名（实测把「用 WorkBuddy 写公众号文章」
   *   误判成 obsidian-wechat-converter）。
   *   只有报告阶段能拿到完整时间线，看出「连续几小时都在做同一类事」。
   *
   * 失败时返回 null，调用方回退到本地 Jaccard 聚类。
   */
  private async generateGlobalThemes(
    sessions: any[],
    dateKey: string
  ): Promise<ThemeCluster[] | null> {
    const apiBase = this.config.reportApiBase || this.config.llmApiBase;
    const apiKey =
      this.config.reportApiKey !== undefined ? this.config.reportApiKey : this.config.llmApiKey;
    const hasLlm = !!apiKey || apiBase.includes("localhost") || apiBase.includes("127.0.0.1");
    if (!hasLlm || sessions.length === 0) return null;

    // 构造精简清单：给模型足够判断依据，但不塞入全部 OCR 原文。
    // 除 title 外，额外喂入 description / topics / 高信号 entities（identifiers、decisions），
    // 这些是单会话分析阶段 LLM 已经产出的精确信息，此前完全没被利用。
    const byId = new Map<string, any>();
    const items = sessions.map((s, i) => {
      const id = `s${i}`;
      byId.set(id, s);
      const d = new Date(s.row.startedAt);
      const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

      // description 截断到 80 字，避免 prompt 膨胀
      const desc = (s.row.analysisDescription || "").replace(/\s+/g, " ").trim();
      const summary = desc ? desc.slice(0, 80) : "";

      // topics 直接用（最多 4 个）
      const topics: string[] = Array.isArray(s.row.topics) ? s.row.topics.slice(0, 4) : [];

      // 高信号实体：从 entities 里取 identifiers / decisions，
      // 去重、限长、限条数（合计最多 5 条、每条 ≤40 字）。
      // 注意：多数会话可能只有 1 条甚至 0 条，有则取、无则空，不硬凑。
      const signals = this.pickHighSignalEntities(s.row.entities);

      const item: any = {
        id,
        time: hhmm,
        minutes: Math.max(1, Math.round((s.row.durationMs || 0) / 60000)),
        apps: s.row.appNames,
        title: s.row.analysisTitle || "(无标题)"
      };
      if (summary) item.summary = summary;
      if (topics.length > 0) item.topics = topics;
      if (signals.length > 0) item.signals = signals;

      // 客观行为信号（纯计算派生自 events）：帮助 LLM 判断深度工作 vs 碎片切换。
      // focusSwitches 高 + clickRate 高 = 频繁切换；focusSwitches 低 = 偏专注。
      const act = s.row.signals?.activity;
      if (act && typeof act === "object") {
        const brief: any = {};
        if (typeof act.focusSwitches === "number") brief.focusSwitches = act.focusSwitches;
        if (typeof act.clickRate === "number") brief.clickRate = act.clickRate;
        if (Object.keys(brief).length > 0) item.activity = brief;
      }
      return item;
    });

    // 分批：按估算 token 切块，避免单次 prompt 过大（原实现固定 60 条无 token 预算）。
    // 粗估：一个中文字符 ≈ 1 token，一个 ASCII 词 ≈ 0.3 token；这里用 JSON 长度 / 2
    // 作为保守的 token 估算（JSON 里 ASCII 占多数），单块预算 ~6000 token。
    const chunks: any[][] = [];
    const TOKEN_BUDGET = 6000;
    let cur: any[] = [];
    let curTokens = 0;
    for (const it of items) {
      const est = Math.ceil(JSON.stringify(it).length / 2);
      if (cur.length > 0 && curTokens + est > TOKEN_BUDGET) {
        chunks.push(cur);
        cur = [];
        curTokens = 0;
      }
      cur.push(it);
      curTokens += est;
    }
    if (cur.length > 0) chunks.push(cur);

    const merged = new Map<string, { name: string; ids: string[]; lines: string[] }>();
    // 全局归纳阶段修正的会话标题：id -> 新标题
    const titleFixes = new Map<string, string>();

    for (const chunk of chunks) {
      // 脱敏：此通道此前直接 JSON.stringify 拼进 prompt，无脱敏，
      // 会把 identifiers 里的密钥/Token（如 WAFFO_PRIVATE_KEY）送给 LLM。
      // 单会话分析阶段走了 redactSensitiveText，这里必须对齐（AGENTS.md 隐私铁律）。
      const rawPrompt = `以下是 ${dateKey} 的会话清单，请归并为若干核心主题。

${JSON.stringify(chunk, null, 2)}`;
      const prompt = redactSensitiveText(rawPrompt).redacted;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 90000);
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

        const res = await fetch(`${apiBase.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: this.config.reportModel,
            messages: [
              { role: "system", content: OTUS_THEME_SYSTEM_PROMPT },
              { role: "user", content: prompt }
            ],
            temperature: 0.3
          })
        }).finally(() => clearTimeout(timeout));

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as any;
        const text = data.choices?.[0]?.message?.content?.trim() || "";
        const parsed = this.cleanAndParseJSON(text);
        if (!parsed?.themes || !Array.isArray(parsed.themes)) throw new Error("响应缺少 themes");

        for (const t of parsed.themes) {
          const name = String(t?.name || "").trim();
          const ids = Array.isArray(t?.sessionIds) ? t.sessionIds : [];
          if (!name || ids.length === 0) continue;
          const narrative = typeof t?.narrative === "string" ? t.narrative.trim() : "";
          const safeNarrative = narrative && narrative.length <= 300 ? narrative : "";
          // 同一主题名跨批次时合并
          const key = name.toLowerCase();
          const existing = merged.get(key);
          if (existing) {
            existing.ids.push(...ids);
            if (!existing.lines.length && safeNarrative) existing.lines.push(safeNarrative);
          } else {
            merged.set(key, { name, ids: [...ids], lines: safeNarrative ? [safeNarrative] : [] });
          }
        }

        // 收集标题修正建议（id -> 新标题）
        if (Array.isArray(parsed.titles)) {
          for (const t of parsed.titles) {
            const id = String(t?.id || "").trim();
            const title = String(t?.title || "").trim();
            if (!id || !title) continue;
            if (!byId.has(id)) continue;
            // 只收合理长度的标题，防止模型吐长句
            if (title.length > 40) continue;
            titleFixes.set(id, title);
          }
        }
      } catch (err: any) {
        console.warn(
          `[ActivitySummarizer] 全局主题归纳失败（${err?.message || err}），回退到本地聚类`
        );
        return null;
      }
    }

    if (merged.size === 0) return null;

    // 应用全局归纳给出的标题修正：就地改内存对象 + 写库
    // 病根：analysis_title 是逐会话生成的，只看得到单段活动，易被侧边栏/历史里的
    // 项目名带偏（例：在 AI 对话里修 Otus，侧边栏列出 dsh-market，标题就写成了
    // 「修复 dsh-market 菜单栏图标崩溃」）。全局视角能结合前后文纠正。
    for (const [id, title] of titleFixes) {
      const s = byId.get(id);
      if (!s) continue;
      if ((s.row.analysisTitle || "") === title) continue;
      s.row.analysisTitle = title;
      try {
        this.store.updateSessionTitle(s.row.id, title);
      } catch (err: any) {
        console.warn(`[ActivitySummarizer] 回写标题失败（${s.row.id}）：${err?.message || err}`);
      }
    }

    // 校验：LLM 只能使用给定编号，且每个编号只能出现一次
    const assigned = new Set<string>();
    const clusters: ThemeCluster[] = [];
    for (const { name, ids, lines } of merged.values()) {
      const members: any[] = [];
      for (const id of ids) {
        const s = byId.get(id);
        if (!s || assigned.has(id)) continue;
        assigned.add(id);
        members.push(s);
      }
      if (members.length === 0) continue;
      const entities: Record<string, any[]> = {};
      let totalMs = 0;
      const topics: string[] = [];
      for (const m of members) {
        this.mergeEntities(entities, m.row.entities);
        totalMs += m.row.durationMs || 0;
        for (const t of m.row.topics || []) if (!topics.includes(t)) topics.push(t);
      }
      clusters.push({
        key: `theme:${name.toLowerCase()}`,
        project: null,
        sessions: members,
        entities,
        topics,
        totalMs,
        displayName: name,
        themeLines: lines && lines.length ? lines : undefined
      } as ThemeCluster);
    }

    // 未分配到的会话（模型漏掉的）补一个「其他」主题，避免丢数据
    const leftovers = sessions.filter((s, i) => !assigned.has(`s${i}`));
    if (leftovers.length > 0) {
      const entities: Record<string, any[]> = {};
      let totalMs = 0;
      const topics: string[] = [];
      for (const m of leftovers) {
        this.mergeEntities(entities, m.row.entities);
        totalMs += m.row.durationMs || 0;
        for (const t of m.row.topics || []) if (!topics.includes(t)) topics.push(t);
      }
      clusters.push({
        key: "theme:其他零碎",
        project: null,
        sessions: leftovers,
        entities,
        topics,
        totalMs,
        displayName: "其他零碎"
      } as ThemeCluster);
    }

    console.log(
      `[ActivitySummarizer] 全局主题归纳完成：${sessions.length} 个会话 → ${clusters.length} 个主题`
    );
    return clusters;
  }

  // 🔢 数学聚类：TF-IDF + 平均链接 HAC（替换原贪心单遍）
  //
  // 为什么改：
  //  - 原「贪心单遍 + Jaccard≥0.18」对输入顺序敏感（同一批会话换序结果不同），
  //    且 0.18 阈值是拍脑袋。HAC 每步合并「全局」最相似的一对簇，无顺序概念，
  //    从原理上根治顺序敏感；切割高度由当天距离分布自适应决定。
  //  - 原 token 只取结构化字段（project/topics/entities），丢了标题/描述的自然语言，
  //    导致「同一件事不同措辞」无法靠近。现改用 sessionDocText 融合自然语言 + 结构化。
  //  - 时间连续性作为「弱辅助」惩罚项进入距离矩阵（β 封顶），替代原先「时间窗口+同 App」硬规则。
  private clusterSessions(sessions: any[]): ThemeCluster[] {
    if (sessions.length === 0) return [];
    const sorted = [...sessions].sort((a, b) => a.row.startedAt - b.row.startedAt);

    // 1) 逐会话生成文档文本 → TF-IDF 向量
    const docs = sorted.map((s) => tokenize(this.sessionDocText(s)));
    const vecs = tfidf(docs);

    // 2) HAC 聚类（时间戳用于弱时间惩罚）
    const timestamps = sorted.map((s) => s.row.startedAt);
    const rawClusters = hacCluster(vecs, {
      cutDistance: this.config.clusterCutDistance,
      timeBeta: this.config.clusterTimeBeta,
      timeTau: this.config.clusterTimeTauMs,
      timestamps
    });

    // 3) 把索引簇转成 ThemeCluster，并做「App 兼容性」后校验：
    //    HAC 可能把「共享词但不同 App 族」的会话并一起（如都用 Chrome），
    //    这里对每个多成员簇按共享 App 再细分成子簇，避免跨 App 污染。
    const clusters: ThemeCluster[] = [];
    for (const rc of rawClusters) {
      const items = rc.members.map((i) => sorted[i]);
      const subGroups: any[][] = [];
      for (const item of items) {
        // 找能容纳它的子组（共享 App 或共享 repo 实体）
        let placed = false;
        for (const g of subGroups) {
          const merged = this.newCluster(`tmp:${clusters.length}:${subGroups.indexOf(g)}`, g[0]);
          for (const gi of g.slice(1)) {
            merged.sessions.push(gi);
            this.mergeEntities(merged.entities, gi.row.entities);
            for (const t of gi.row.topics || []) if (!merged.topics.includes(t)) merged.topics.push(t);
            merged.totalMs += gi.row.durationMs || 0;
          }
          if (this.isCompatibleWithCluster(merged, item)) { g.push(item); placed = true; break; }
        }
        if (!placed) subGroups.push([item]);
      }
      for (const g of subGroups) {
        const cl = this.newCluster(`sess:${g[0].row.id}`, g[0]);
        for (const extra of g.slice(1)) {
          cl.sessions.push(extra);
          this.mergeEntities(cl.entities, extra.row.entities);
          for (const t of extra.row.topics || []) if (!cl.topics.includes(t)) cl.topics.push(t);
          cl.totalMs += extra.row.durationMs || 0;
        }
        clusters.push(cl);
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

  /**
   * 判断会话是否与已有簇「内容兼容」。
   *
   * 目的：防止 LLM 误判 project 后污染整个主题。
   * 实测案例：用 Obsidian 写关于 WorkBuddy 的公众号文章，
   * LLM 把 project 判成 obsidian-wechat-converter，
   * 导致 9 个「写稿做图」会话被归进「改插件代码」的主题。
   *
   * 判定依据（按可靠性排序）：
   *   1. 共享 App（必要信号，最直接）：没有共同 App 视为不同活动
   *   2. 共享实体（严格信号）：同仓库的 issue/pr 视为同一项目
   * 两者都满足其一即兼容。
   */
  private isCompatibleWithCluster(cluster: ThemeCluster, item: any): boolean {
    // 1. 共享 App
    const clusterApps = new Set<string>();
    for (const s of cluster.sessions) {
      for (const a of s.row.appNames || []) clusterApps.add(a);
    }
    const itemApps = item.row.appNames || [];
    const sharesApp = itemApps.some((a: string) => clusterApps.has(a));

    // 2. 共享 repo/issue 实体
    const clusterRepos = new Set<string>([
      ...(cluster.entities.repos || []),
      ...(cluster.entities.issues || []).map((i: any) => i?.repo).filter(Boolean)
    ].map((r: string) => String(r).toLowerCase()));
    const itemRepos = [
      ...(item.row.entities?.repos || []),
      ...(item.row.entities?.issues || []).map((i: any) => i?.repo).filter(Boolean)
    ].map((r: string) => String(r).toLowerCase());
    const sharesRepo = itemRepos.some((r) => clusterRepos.has(r));

    // 只要共享 App 或共享仓库其一即可同簇
    return sharesApp || sharesRepo;
  }

  /**
   * 为一个会话生成「可比较的文本」用于 TF-IDF 向量化。
   * 把结构化高信号（project/topics/entities）+ 自然语言（标题/描述）合在一起：
   *  - 自然语言部分让「同一件事的不同措辞」通过字符 bigram 有重叠；
   *  - 结构化部分（尤其 project/repo/issue ref）是稀有 token，TF-IDF 会给高 IDF 权重。
   * 拼接后整体喂给 tokenize()。
   */
  private sessionDocText(item: any): string {
    const parts: string[] = [];
    const r = item.row;
    if (r.analysisTitle) parts.push(r.analysisTitle);
    if (r.analysisDescription) parts.push(String(r.analysisDescription).slice(0, 200));
    if (r.project) parts.push("proj " + r.project);
    for (const t of r.topics || []) parts.push(String(t));
    const e = r.entities || {};
    for (const pr of e.prs || []) parts.push(String(pr.label || pr.ref || ""));
    for (const iss of e.issues || []) parts.push(String(iss.label || iss.ref || ""));
    for (const c of e.commits || []) parts.push(String(c.label || c.ref || ""));
    for (const p of e.people || []) parts.push(String(p.handle || ""));
    for (const id of e.identifiers || []) parts.push(String(id));
    // OCR 摘录也纳入（截断，避免噪声过大）
    for (const ocr of item.ocrSnippets || []) parts.push(String(ocr).slice(0, 120));
    return parts.join(" ");
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

  /**
   * 生成骨架头部（一级标题 + 全天统计行）。
   *
   * 这一部分完全由代码生成，绝不交给 LLM 重写——
   * 实测 LLM 会把 2026 写成 2025、把统计行整段删掉。
   * 拆分后 LLM 只负责各主题的段落措辞，从结构上就改不到事实。
   */
  private buildSkeletonHeader(dateKey: string, stats: any): string[] {
    const [year, month, day] = dateKey.split("-").map(Number);
    const dayOfWeek = ["日", "一", "二", "三", "四", "五", "六"][
      new Date(year, month - 1, day).getDay()
    ];
    const lines: string[] = [];

    lines.push(`# ${dateKey} 周${dayOfWeek} 个人折腾日记`);
    lines.push("");

    const topAppsStr = stats.topApps?.length
      ? ` 主用：${stats.topApps.map((a: any) => `${a.app} (${a.minutes}m)`).join("、")}。`
      : "";
    const filteredStr = stats.filteredCount > 0 ? `，${stats.filteredCount} 个闲置已过滤` : "";
    // 活跃时长口径说明：totalActiveMinutes 是各会话有效输入时长累加，
    // 与墙钟跨度（首末会话间隔）不同，单看前者容易高估在岗时间。
    const spanStr =
      stats.wallClockHours > 0
        ? `跨度为 ${stats.wallClockHours} 小时，有效利用率 ${stats.utilizationPct}%`
        : "";
    lines.push(
      `有效活跃 ${stats.totalActiveMinutes} 分钟${spanStr ? `（${spanStr}）` : ""}，共 ${stats.sessionCount} 个 session（${stats.analyzedCount} 个实质折腾${filteredStr}），归类为 ${stats.clusterCount} 个核心主题。${topAppsStr}`
    );
    lines.push("");

    return lines;
  }

  // 原生 Markdown 骨架生成器
  private buildSkeleton(clusters: ThemeCluster[], dateKey: string, stats: any): string {
    const lines: string[] = this.buildSkeletonHeader(dateKey, stats);

    // 概览优先：纯按总时长降序（不再以 PR/Issue 数量优先，
    // 因为很多活动是写文档/调配置/试工具，本身不产出代码工件）
    const sorted = [...clusters].sort((a, b) => b.totalMs - a.totalMs);

    for (const c of sorted) {
      // 优先使用全局归纳给出的主题名；否则回退到 project/topics/标题推导
      const themeTitle =
        c.displayName ||
        (c.key === "misc"
          ? "其他零碎"
          : c.project || c.topics[0] || c.sessions[0]?.row.analysisTitle || "日常专注");
      const totalMin = Math.round(c.totalMs / 60000);
      const sessCount = c.sessions.length;

      lines.push(`## ${themeTitle}`);
      lines.push(`_${totalMin} 分钟 · ${sessCount} 个 session_`);
      lines.push("");

      // 主线优先用 LLM 全局归纳提炼的 themeLines（它能看全主题的会话，
      // 把「注册 Webhook / 删旧 Webhook / 改脚本域名」这类同一件事的不同
      // 侧面合并成一条，比任何字符串相似度算法都准）。
      // 只有 LLM 归纳失败、回退到本地聚类时才用 highlights + 字符串去重兜底。
      let highlights: string[];
      if (c.themeLines && c.themeLines.length) {
        highlights = c.themeLines;
      } else {
        const rawHighlights: string[] = [];
        for (const s of c.sessions) {
          for (const h of s.row.highlights || []) {
            if (!rawHighlights.includes(h)) rawHighlights.push(h);
          }
        }
        highlights = this.dedupeHighlights(rawHighlights);
      }
      if (highlights.length) {
        for (const h of highlights) {
          lines.push(`- ${h}`);
        }
      }

      // 结果性产出：只在有「合并/发布」这类明确成果时补一句
      // （不是列举所有 PR/Issue，而是当天真正落地的结果）
      const outcomes: string[] = [];
      if (c.entities.prs?.length) {
        const merged = c.entities.prs.filter((p: any) => p.state === "merged" || p.merged);
        if (merged.length) outcomes.push(`${merged.length} 个 PR 已合并`);
      }
      if (c.entities.versions?.length) {
        const vers = c.entities.versions.map((v: any) => v.label).filter(Boolean);
        if (vers.length) outcomes.push(`涉及版本 ${vers.join("、")}`);
      }
      if (outcomes.length) {
        lines.push("");
        lines.push(`_成果：${outcomes.join(" · ")}_`);
      }
      lines.push("");
    }

    return lines.join("\n").trim();
  }

  /**
   * highlights 智能去重。
   *
   * 报告只做概览，但「有多少说多少」——不能因为怕长就硬砍成固定 N 条，
   * 也不能把同一件事的七八个侧面全列出来。
   *
   * 做法：字符 bigram 集合的 Jaccard 相似度聚类，相似度 >= 0.45 视为
   * 同一件事；每簇取「信息量最大」的一条（长度适中、含具体名词/数字者优先）
   * 作代表。这样：真正不同的主线都会保留，重复侧面的会被合并。
   */
  private dedupeHighlights(items: string[]): string[] {
    if (items.length <= 3) return items;

    // 🔢 MMR 边际相关性去重（替换原「bigram Jaccard≥0.45 聚类取最长」）。
    // 为什么改：原方法只能合并「字面高度重叠」的句子，对同义改写无能——
    // 实测 30 条讲同一件事的不同表述，去重后仍是 30 条。
    // MMR 用「相关性 − 与已选最大相似度」的贪心选择，天然带多样性惩罚，
    // 既保主题相关、又压掉重复侧面，且无需人工阈值。
    // 信息量评分沿用原启发式（长度适中 + 数字/英文专名加分）作为相关性。
    const score = (s: string): number => {
      const len = s.length;
      let sc = len >= 10 && len <= 60 ? len : len < 10 ? len * 0.5 : 60 - (len - 60) * 0.3;
      const numbers = (s.match(/\d+|[A-Za-z]{3,}/g) || []).length;
      return sc + numbers * 3;
    };
    const rel = items.map(score);
    // 目标条数：保留约 sqrt(n) 到 6 条之间，至少 3 条（避免过度压缩成 1 条）
    const k = Math.max(3, Math.min(6, Math.round(Math.sqrt(items.length)) + 1));
    const chosen = mmrSelect(items, rel, k, 0.6);
    // 按原顺序输出（保持时间线自然顺序）
    return chosen.sort((a, b) => a - b).map((i) => items[i]);
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

  /**
   * 校验 LLM 润色结果是否忠实于骨架事实。
   *
   * 背景：系统提示词虽已写「严禁编造事实」，但实测 LLM 仍会把 2026 写成 2025、
   * 整段丢失统计行。提示词是「请求」，确定性校验才是「强制」。
   *
   * 任一硬性项失败即判定不可用，调用方应回退到骨架。
   */
  private validateNarrative(
    skeleton: string,
    polished: string,
    dateKey: string
  ): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];

    // ── 硬性项 1：一级标题的日期必须一致且出现
    if (!polished.includes(dateKey)) {
      reasons.push(`输出中缺少日期 ${dateKey}`);
    }
    const otherDates = [...polished.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)]
      .map((m) => m[1])
      .filter((d) => d !== dateKey);
    if (otherDates.length > 0) {
      reasons.push(`出现与目标日期不符的日期：${[...new Set(otherDates)].slice(0, 3).join("、")}`);
    }
    if (!/^#\s+\S/.test(polished.trim())) {
      reasons.push("缺少一级标题");
    }

    // ── 硬性项 2：骨架中的 PR / Issue 编号必须原样保留
    const refPatterns = [/\b(?:PR|pr)\s*#?\d+/g, /\b(?:Issue|issue|#)\s*#?\d+/g, /\bv?\d+\.\d+\.\d+\b/g];
    const skeletonRefs = new Set<string>();
    for (const re of refPatterns) {
      for (const m of skeleton.matchAll(re)) skeletonRefs.add(m[0].replace(/\s+/g, " ").trim());
    }
    const missingRefs = [...skeletonRefs].filter((ref) => !polished.includes(ref));
    if (missingRefs.length > 0) {
      // 允许最多丢失 20% 的编号（LLM 适度精简），超出则判定失败
      const lossRatio = missingRefs.length / skeletonRefs.size;
      if (lossRatio > 0.2) {
        reasons.push(
          `丢失 ${missingRefs.length}/${skeletonRefs.size} 个编号引用（如 ${missingRefs.slice(0, 3).join("、")}）`
        );
      }
    }

    // ── 硬性项 3：统计关键数字必须保留
    const statLine = skeleton.split("\n").find((l) => l.includes("有效活跃") || l.includes("活跃"));
    if (statLine) {
      const nums = [...statLine.matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]);
      // 取显著的统计数字（排除过小的序号）
      const keyNums = nums.filter((n) => Number(n) >= 10).slice(0, 6);
      const missingNums = keyNums.filter((n) => !polished.includes(n));
      if (missingNums.length > Math.max(1, Math.floor(keyNums.length / 2))) {
        reasons.push(`统计数字大量丢失（缺 ${missingNums.slice(0, 4).join("、")}）`);
      }
    }

    // ── 硬性项 4：不能凭空出现骨架里没有的 URL
    const urlPattern = /https?:\/\/[^\s)\]"'<>]+/g;
    const skeletonUrls = new Set((skeleton.match(urlPattern) || []).map((u) => u.replace(/[.,;]$/, "")));
    const polishedUrls = (polished.match(urlPattern) || []).map((u) => u.replace(/[.,;]$/, ""));
    const fabricatedUrls = polishedUrls.filter(
      (u) => !skeletonUrls.has(u) && ![...skeletonUrls].some((s) => s.startsWith(u) || u.startsWith(s))
    );
    if (fabricatedUrls.length > 0) {
      reasons.push(`出现骨架中没有的链接：${fabricatedUrls.slice(0, 2).join("、")}`);
    }

    // ── 硬性项 5：正文长度不得严重缩水（防止整段丢失）
    if (skeleton.length > 200 && polished.length < skeleton.length * 0.4) {
      reasons.push(
        `正文长度从 ${skeleton.length} 缩至 ${polished.length}（不足骨架 40%），疑似整段丢失`
      );
    }

    return { ok: reasons.length === 0, reasons };
  }

  /**
   * 第一人称润色。
   *
   * 只接收「主题正文」（不含一级标题与全天统计行），
   * 因此输出中不应出现 `# 一级标题`，由调用方负责拼回头部。
   */
  private async narrativePass(body: string, dateKey: string): Promise<string> {
    const apiBase = this.config.reportApiBase || this.config.llmApiBase;
    const apiKey = this.config.reportApiKey !== undefined ? this.config.reportApiKey : this.config.llmApiKey;
    const url = `${apiBase.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

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
                content: `以下是 ${dateKey} 当天的主题正文骨架（不含一级标题与全天统计行，这两部分由程序负责，你不要输出）。请按所有规则把它改写成第一人称日记正文，只保留二级标题及其下的内容。

${body}`
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
    const apiBase = this.config.reportApiBase || this.config.llmApiBase;
    const apiKey = this.config.reportApiKey !== undefined ? this.config.reportApiKey : this.config.llmApiKey;
    const url = `${apiBase.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

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

    // 启发式高质量洞察兜底
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
