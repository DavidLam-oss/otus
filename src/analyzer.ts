import { ActivityStore } from "./store.ts";
import type { ActivitySession } from "./store.ts";
import { defaultConfig } from "./config.ts";
import type { OtusConfig } from "./config.ts";
import { redactSensitiveText } from "./redactor.ts";

const OTUS_ANALYZER_SYSTEM_PROMPT = `你是桌面活动记录器的微会话分析器。输入是一个工作会话的 OCR 文本、用过的 App、
浏览器访问记录和窗口标题。输出结构化 JSON，见末尾格式。

## 唯一判据：实际产出了什么

App 名、侧边栏项目名、历史任务标题只是背景，不是产出。由此三条：
1. title 直述实际做了什么（「修通 License.ts 字段名 Bug」）。严禁
   「在 Chrome 中浏览网页」「处理项目」「Coding in VS Code」「测试」
   这类把 App 当主语或什么都没说的空壳标题（含中英混写）。
2. project 只在出现**该项目自身的产物**、且项目名逐字出现在该产物上才填
   （"owner/repo"、"repo/src/x.ts"、仓库 Issue/PR 标题、发布页面）。
   裸路径看不出属于谁（"src/x.ts"）→ null；借用 App 写稿/做图、谈论检索、
   侧边栏项目名 → 都 null。
3. 专注度看是否同一件事贯穿，不看 App 切换多少。

## 正反对照

输入：用 Obsidian 和 WorkBuddy 排版公众号文章，侧边栏列出了 obsidian-wechat-converter。
错：title「调试 obsidian-wechat-converter」、project「obsidian-wechat-converter」
错在：侧边栏的项目名不是产物，用户实际在写稿。
对：title「排版公众号文章」、project null

输入：在 Claude 里改 obsidian-wechat-converter 的会话切分，OCR 有
"obsidian-wechat-converter/src/recorder.ts" 和 "git commit -m fix: merge adjacent"。
对：title「修复 obsidian-wechat-converter 相邻会话合并」、
project「obsidian-wechat-converter」、project_evidence「obsidian-wechat-converter/src/recorder.ts」

输入：在 VS Code 里给本职项目改 src/recorder.ts 并 git commit，没出现别的项目名。
对：project null（路径没指明属于哪个项目，不能猜）

输入：反复调试截图体积，最后对齐 Alma 的 2560/55 并补全三级轮转。
对：memoryCandidates「Otus 截图参数对齐 Alma：2560 宽 / quality 55」

输入：在 Chrome 里刷了几页新闻、刷了会儿微博，没做任何产出。
对：memoryCandidates 空数组

## 硬性要求

- 中文输出，专有名词（项目名、PR 号、函数名、API、分支、英文产品名）保留原样。
- 严禁编造。PR 号、Issue、Commit、版本号、人名必须在输入中原样出现。
- project_evidence 逐字复制输入中的连续原文片段（不改写、概括、翻译）；
  找不到就与 project 双双填 null。
- worth 为 false 仅限：纯锁屏（loginwindow/ScreenSaver/LockScreen）、无输入闲置挂机、
  OCR 无实质操作内容、漫无目的刷网页/刷社交。切换 App 多、页面杂不等于没干活，
  但只是翻过去、没产出东西就是 false。
- 「某产品怎么用」≠ 改它的代码；读文档/看教程属于学习。

## 输出格式（严格 JSON）

{
  "worth": boolean,                  // 实质折腾/编码/深度阅读/沟通学习为 true
  "title": string,                   // <=30 字中文短语，直击核心行动与产出
  "description": string,             // <=120 字，1-2 句概括实际操作与关键产出
  "project": string | null,
  "project_evidence": string | null,
  "topics": string[],                // 2-4 个精炼标签，如 ["发布","eslint","样式调试"]
  "highlights": string[],            // 1-3 条具体行动/产出要点，<=60 字/条
  "entities": {
    "prs" | "issues" | "commits": [{"label": string, "ref"?: string, "repo"?: string, "url"?: string}],
    "people": [{"handle": string, "name"?: string}],
    "identifiers" | "repos" | "versions" | "events" | "decisions" | "urls": string[]
  },                                 // 只在输入原文出现过才填，宁空勿猜
  "memoryCandidates": string[],      // 值得长期记住的结论/决定/踩坑，每条 <=40字；
                                     // 没有可长期复用的结论就给空数组，不要凑
  "worthKnowledge": boolean,         // 是否含可复用知识（技术方案、文档、踩坑经验）
  "isMeeting": boolean               // 是否音视频会议/通话
}`;

export class ActivityAnalyzer {
  private store: ActivityStore;
  private config: OtusConfig;
  private timer: NodeJS.Timeout | null = null;
  private running: boolean = false;
  private isUserActive?: () => boolean;

  constructor(store: ActivityStore, config: Partial<OtusConfig> = {}, isUserActive?: () => boolean) {
    this.store = store;
    this.config = { ...defaultConfig, ...config };
    this.isUserActive = isUserActive;
  }

  public start(): void {
    if (this.timer) return;
    console.log("[ActivityAnalyzer] Starting micro-session analyzer...");
    // 启动延迟 2 分钟首次跑，之后每 3 分钟检查一次
    setTimeout(() => {
      this.runOnce().catch((err) => console.error("[ActivityAnalyzer] First pass error:", err));
    }, 10000);

    this.timer = setInterval(() => {
      if (!this.isUserActive?.()) {
        this.runOnce().catch((err) => console.error("[ActivityAnalyzer] Periodic error:", err));
      }
    }, 180000);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async runOnce(opts: { limit?: number; includeFailed?: boolean } = {}): Promise<{ processed: number; analyzed: number; failed: number }> {
    if (this.running) return { processed: 0, analyzed: 0, failed: 0 };
    this.running = true;
    let processed = 0;
    let analyzed = 0;
    let failed = 0;

    const limit = opts.limit ?? 20;
    try {
      // 0. 分析前先合并相邻碎片会话（对齐 Alma 的 mergePendingAdjacent）
      // 采集层按 idleThresholdMs 切出的碎片本身是正常的，但逐个送进 LLM
      // 会得到「同一件事被拆成几十条」的失真报告，必须先聚合。
      const merged = this.mergePendingAdjacent();
      if (merged > 0) {
        console.log(`[ActivityAnalyzer] 合并了 ${merged} 组相邻碎片会话`);
      }

      // 优先获取 pending 状态的会话；若未达到 limit，则补充分派失败 (failed) 的会话重新分析
      let targets = this.store.listSessions({ analysisStatus: "pending", limit });

      // 其次补充离线启发式兜底的会话：这些会话虽标记为 analyzed，
      // 但标题/描述由本地规则生成（质量低），在 LLM 恢复后应重新分析。
      // 仅当配置了可用的 LLM 时才纳入，避免无 LLM 时反复重跑同一批会话。
      if (targets.length < limit && this.hasLlmConfigured()) {
        const offlineSessions = this.store.listSessions({
          analysisStatus: "analyzed",
          analysisModel: "offline-heuristic",
          limit: limit - targets.length
        });
        if (offlineSessions.length > 0) {
          console.log(
            `[ActivityAnalyzer] 重新分析 ${offlineSessions.length} 个离线启发式会话（LLM 已可用）`
          );
          targets = [...targets, ...offlineSessions];
        }
      }

      if (opts.includeFailed !== false && targets.length < limit) {
        const failedSessions = this.store.listSessions({
          analysisStatus: "failed",
          limit: limit - targets.length
        });
        targets = [...targets, ...failedSessions];
      }

      for (const sess of targets) {
        if (!sess.endedAt) continue;
        processed++;
        const res = await this.analyzeSession(sess).catch((err) => {
          console.error(`[ActivityAnalyzer] Session ${sess.id} failed:`, err);
          failed++;
          return "failed";
        });
        if (res === "analyzed") analyzed++;
        // 错峰停顿 1 秒 (给大模型网关缓冲)
        await new Promise((r) => setTimeout(r, 1000));
      }
    } finally {
      this.running = false;
    }

    return { processed, analyzed, failed };
  }

  /**
   * 合并相邻的碎片会话（对齐 Alma 的 mergePendingAdjacent）。
   *
   * 判定条件（需同时满足）：
   *   1. 两个会话都已结束
   *   2. 间隔 < mergeGapMs（默认 5 分钟）
   *   3. 至少有一个共同使用的 App（避免把「看网页」和「写代码」拼在一起）
   *
   * 重要：不再只限于 pending 会话。
   * 生产时序下会话结束后约 100 秒就会被单条分析，合并追不上；
   * 因此对「较短且已分析」的会话也做合并，合并体重置为 pending 重新分析。
   *
   * 保护条件（避免误伤）：
   *   - 只合并短会话（durationMs < mergeMaxDurationMs），长会话本就是完整活动单元
   *   - 不合并 marked 为 meeting 的会话（会议有独立语义）
   *   - 至少有一方是短碎片才合并，避免两个长会话被拼在一起
   *
   * 合并方向：后一个会话并入前一个，保留时间轴上更早的作为主体。
   *
   * 防过度合并：
   *   - 记录每个合并体的「原始结束时间」，间隔判断始终基于上一段原始片段，
   *     避免链式合并把 A→B→C→D 累积成一整个下午
   *   - 合并体总时长不得超过 mergeGapMs，防止把长时间跨度的活动拼成一条
   */
  public mergePendingAdjacent(): number {
    // 注意：listSessions 按 started_at ASC 返回，limit 会截断到「最早的 N 条」。
    // 合并只关心近期会话，因此先取足够大的时间窗（24 小时）再在内存中排序。
    const since = Date.now() - 24 * 3600 * 1000;
    const candidates = this.store
      .listSessions({ since, limit: 2000 })
      .filter((s) => s.endedAt !== null)
      .sort((a, b) => a.startedAt - b.startedAt);

    // 合并体追踪：targetId → 该合并体覆盖的时间跨度与「最后一段原始片段」的结束时间
    const chainEnd = new Map<string, number>();   // 最后一段原始片段的 endedAt
    const chainStart = new Map<string, number>(); // 合并体最早开始时间

    let merged = 0;
    for (let i = 0; i < candidates.length - 1; i++) {
      const prev = candidates[i];
      const next = candidates[i + 1];

      // 间隔以「上一段原始片段的结束时间」为准，而不是合并体总结束时间
      const prevRawEnd = chainEnd.get(prev.id) ?? (prev.endedAt ?? prev.startedAt);
      const gap = next.startedAt - prevRawEnd;
      if (gap < 0 || gap > this.config.mergeGapMs) continue;

      // 至少有一方是短碎片，才有合并意义
      const prevShort = (prev.durationMs || 0) < this.config.mergeMaxDurationMs;
      const nextShort = (next.durationMs || 0) < this.config.mergeMaxDurationMs;
      if (!prevShort && !nextShort) continue;

      // 合并体总时长不得超过合并窗口，防止无限链式累积
      const prevStart = chainStart.get(prev.id) ?? prev.startedAt;
      const nextEnd = next.endedAt ?? next.startedAt;
      if (nextEnd - prevStart > this.config.mergeGapMs) continue;

      // 会议会话保持独立
      if (prev.isMeeting || next.isMeeting) continue;

      // 两者都记录了 App 且完全没有交集时，视为不同活动，不合并
      const hasCommonApp =
        prev.appNames.length === 0 ||
        next.appNames.length === 0 ||
        prev.appNames.some((a) => next.appNames.includes(a));
      if (!hasCommonApp) continue;

      if (this.store.mergeSessionInto(next.id, prev.id)) {
        // 合并体可能已分析过，需重置为 pending 让新聚合体重新分析
        this.store.resetSessionAnalysis(prev.id);
        merged++;

        // 更新链式追踪：合并体的起点取更早者，最后一段原始片段取 next 的结束时间
        const prevStartForKey = chainStart.get(prev.id) ?? prev.startedAt;
        const nextStartForKey = chainStart.get(next.id) ?? next.startedAt;
        chainStart.set(prev.id, Math.min(prevStartForKey, nextStartForKey));
        chainEnd.set(prev.id, next.endedAt ?? next.startedAt);

        // 更新内存中的 prev，便于继续与下一个会话比较
        const refreshed = this.store.getSession(prev.id);
        if (refreshed) candidates[i] = refreshed;
        candidates.splice(i + 1, 1);
        i--; // 合并后当前位置可能继续与下一个会话相邻
      }
    }
    return merged;
  }

  /**
   * 校验 LLM 给出的 project 是否有真实证据支撑。
   *
   * 做法：要求模型逐字复制一段原文（project_evidence），
   * 然后在本会话的 OCR / 浏览器访问 / App 列表中查找该片段。
   * 找不到就判定为「无证据」，project 降级为 null。
   *
   * 为什么需要：模型会把应用侧边栏、工作区列表、历史任务标题里出现的
   * 项目名误认为「正在操作该项目」，纯提示词约束无法可靠阻止。
   */
  private verifyProjectEvidence(
    parsed: any,
    ctx: { ocrSnippets: string[]; browserVisits: { url: string; title: string }[]; appsUsed: string[] }
  ): string | null {
    const claimed = typeof parsed.project === "string" ? parsed.project.trim() : "";
    if (!claimed) return null;

    const evidence = typeof parsed.project_evidence === "string" ? parsed.project_evidence.trim() : "";

    // 1. 没有提供证据 → 不接受该 project
    if (!evidence) {
      console.warn(`[ActivityAnalyzer] project="${claimed}" 未提供 project_evidence，已降级为 null`);
      return null;
    }

    const norm = (s: string) => s.replace(/\s+/g, "");

    // 2. 证据过短（如只有项目名本身）不足以证明操作，视为无效
    if (norm(evidence).length < 3 || norm(evidence) === norm(claimed)) {
      console.warn(
        `[ActivityAnalyzer] project="${claimed}" 的 evidence 仅为项目名或过短，不足以证明操作行为，已降级为 null`
      );
      return null;
    }

    // 3. 证据必须能在真实输入中找到（忽略空白差异）
    const haystack = norm(
      [
        ...ctx.ocrSnippets,
        ...ctx.browserVisits.map((v) => `${v.url} ${v.title}`),
        ...ctx.appsUsed
      ].join("\n")
    );
    const needle = norm(evidence);

    if (!haystack.includes(needle)) {
      console.warn(
        `[ActivityAnalyzer] project="${claimed}" 的 evidence 无法在输入中定位（"${evidence.slice(0, 60)}"），已降级为 null`
      );
      return null;
    }

    return claimed;
  }

  /** 是否配置了可用的 LLM（用于决定是否重试离线启发式会话） */
  private hasLlmConfigured(): boolean {
    const apiBase = this.config.analysisApiBase || this.config.llmApiBase;
    const apiKey =
      this.config.analysisApiKey !== undefined ? this.config.analysisApiKey : this.config.llmApiKey;
    return !!apiKey || apiBase.includes("localhost") || apiBase.includes("127.0.0.1");
  }

  /** 是否低于质量门槛（对齐 Alma：三项全都低于下限才跳过） */
  private isBelowQualityGate(session: ActivitySession): boolean {
    const durationMs = session.durationMs || 0;
    const events = session.eventCount || 0;
    const snaps = session.snapshotCount || 0;
    return (
      durationMs < this.config.minSessionDurationMs &&
      events < this.config.minSessionEventCount &&
      snaps < this.config.minSessionSnapshotCount
    );
  }

  /**
   * 抽取 OCR 片段（对齐 Alma 的去重策略）。
   *
   * 相较旧实现的两点改进：
   *   1. 用相似度而非全等判重：相邻文本相似度 > ocrDedupThreshold 视为重复，
   *      能过滤掉「同一页面滚动几个像素」产生的近重复 OCR
   *   2. 字符预算从固定 6×400 提升到 ocrCharBudget，给长会话更完整的上下文
   */
  private extractOcrSnippets(sessionId: string): string[] {
    const frames = this.store.listOcrForSession(sessionId, this.config.maxOcrFrames);
    const cleaned: string[] = [];
    for (const f of frames) {
      const t = f.text.replace(/\s+/g, " ").trim();
      if (t) cleaned.push(t);
    }

    // 相邻相似度去重
    const deduped: string[] = [];
    let prev = "";
    for (const t of cleaned) {
      if (!prev || this.textSimilarity(t, prev) <= this.config.ocrDedupThreshold) {
        deduped.push(t);
      }
      prev = t;
    }

    // 按字符预算截断，避免超出 LLM 上下文
    const out: string[] = [];
    let used = 0;
    for (const t of deduped) {
      if (used + t.length > this.config.ocrCharBudget && out.length > 0) break;
      out.push(t);
      used += t.length;
    }
    return out;
  }

  /**
   * 轻量文本相似度（0~1）。用字符二元组 Jaccard，避免引入额外依赖。
   * 对 OCR 场景足够：能识别「同一页面轻微变化」的近重复文本。
   */
  private textSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (!a || !b) return 0;
    const bigrams = (s: string): Set<string> => {
      const set = new Set<string>();
      for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
      return set;
    };
    const A = bigrams(a);
    const B = bigrams(b);
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    return inter / (A.size + B.size - inter);
  }

  public async analyzeSession(session: ActivitySession): Promise<"analyzed" | "not_worth" | "failed"> {
    // 0. 质量前置过滤（对齐 Alma 的 processSession 门槛）
    // 与「交给 LLM 判 not_worth」不同：低于确定阈值时根本不该消耗 LLM 调用。
    // 注意用「或」语义——任一指标达标就仍要分析，避免误杀。
    if (this.isBelowQualityGate(session)) {
      this.store.setSessionAnalysis(session.id, {
        status: "not_worth",
        title: null,
        description: "低于质量门槛，未送分析。",
        model: "quality-gate"
      });
      return "analyzed";
    }

    // 1. 抽取该 session 的 OCR 抽稀片段
    const ocrSnippets = this.extractOcrSnippets(session.id);

    // 2. 抽取浏览器活跃访问与窗口标题
    const events = this.store.listEvents(session.id, 200);
    const browserVisits: { url: string; title: string }[] = [];
    const seenUrls = new Set<string>();
    for (const ev of events) {
      if (ev.kind === "browser_visit" && ev.data?.url && !seenUrls.has(ev.data.url)) {
        seenUrls.add(ev.data.url);
        browserVisits.push({ url: ev.data.url, title: ev.data.title || "" });
        if (browserVisits.length >= 30) break;
      }
    }

    // 3. 构建用户提示词
    const durationMin = Math.max(1, Math.round((session.durationMs || 0) / 60000));
    const promptPayload = {
      sessionId: session.id,
      durationMinutes: durationMin,
      appsUsed: session.appNames,
      browserVisits,
      ocrSnippets
    };

    const userPrompt = `Analyze this work session and return ONLY valid JSON:\n\n${JSON.stringify(promptPayload, null, 2)}`;
    const sanitizedPrompt = redactSensitiveText(userPrompt).redacted;

    // 4. 调用大模型 (若未配置或离线，自动使用本地离线启发式分析兜底，确保全链路跑通)
    const apiBase = this.config.analysisApiBase || this.config.llmApiBase;
    const apiKey = this.config.analysisApiKey !== undefined ? this.config.analysisApiKey : this.config.llmApiKey;
    const hasLlm = !!apiKey || apiBase.includes("localhost") || apiBase.includes("127.0.0.1");
    if (!hasLlm) {
      return this.applyOfflineHeuristic(session, ocrSnippets, "No LLM configured");
    }

    try {
      const response = await this.callLLMWithRetry(
        OTUS_ANALYZER_SYSTEM_PROMPT,
        sanitizedPrompt,
        this.config.analysisModel,
        3
      );
      const parsed = this.cleanAndParseJSON(response);

      if (!parsed || typeof parsed !== "object") {
        console.warn(`[ActivityAnalyzer] Invalid JSON from LLM for session ${session.id}, falling back to offline heuristic...`);
        return this.applyOfflineHeuristic(session, ocrSnippets, "Invalid JSON from LLM");
      }

      // 校验 project 证据：要求 LLM 给出的原文片段真实存在于本次输入中。
      // 背景：模型会把侧边栏/工作区列表里出现的项目名误当成「正在操作该项目」。
      // 仅靠提示词约束不住，必须用可验证的原文做二次确认。
      const project = this.verifyProjectEvidence(parsed, {
        ocrSnippets,
        browserVisits,
        appsUsed: session.appNames
      });

      if (!parsed.worth) {
        this.store.setSessionAnalysis(session.id, {
          status: "not_worth",
          title: parsed.title || null,
          description: parsed.description || null,
          model: this.config.analysisModel,
          worthMemory: false,
          worthKnowledge: false,
          isMeeting: !!parsed.isMeeting,
          entities: this.normalizeEntities(parsed.entities),
          topics: Array.isArray(parsed.topics) ? parsed.topics : [],
          project,
          highlights: Array.isArray(parsed.highlights) ? parsed.highlights : []
        });
        return "not_worth";
      }

      this.store.setSessionAnalysis(session.id, {
        status: "analyzed",
        title: parsed.title || "日常专注折腾",
        description: parsed.description || null,
        model: this.config.analysisModel,
        worthMemory: Array.isArray(parsed.memoryCandidates) && parsed.memoryCandidates.length > 0,
        worthKnowledge: !!parsed.worthKnowledge,
        isMeeting: !!parsed.isMeeting,
        entities: this.normalizeEntities(parsed.entities),
        topics: Array.isArray(parsed.topics) ? parsed.topics : [],
        project,
        highlights: Array.isArray(parsed.highlights) ? parsed.highlights : []
      });

      return "analyzed";
    } catch (err: any) {
      console.warn(
        `[ActivityAnalyzer] LLM analysis failed after retries for session ${session.id} (${err.message}), falling back to offline heuristic...`
      );
      return this.applyOfflineHeuristic(session, ocrSnippets, err.message || "LLM call failed");
    }
  }

  private applyOfflineHeuristic(
    session: ActivitySession,
    ocrSnippets: string[],
    reason: string
  ): "analyzed" | "not_worth" {
    // 过滤出有意义的应用（剔除锁屏、屏保系统进程）
    const realApps = session.appNames.filter(
      (a) => !["loginwindow", "ScreenSaverEngine", "LockScreen", "ScreenSaver"].includes(a)
    );
    const topApp = realApps[0] || "系统环境";
    const sampleOcr = ocrSnippets[0] || "";

    // 过滤条件：无任何实质应用、无输入事件且无有效 OCR 内容，或者包含锁屏
    const hasLockScreen = session.appNames.some((a) =>
      ["loginwindow", "ScreenSaverEngine", "LockScreen", "ScreenSaver"].includes(a)
    );
    const isIdle =
      hasLockScreen ||
      realApps.length === 0 ||
      (session.eventCount === 0 && ocrSnippets.length === 0);

    if (isIdle) {
      this.store.setSessionAnalysis(session.id, {
        status: "not_worth",
        title: `系统锁屏闲置`,
        description: `锁屏或无输入事件，离线判定为闲置 (${reason.slice(0, 100)})。`,
        model: "offline-heuristic",
        worthMemory: false,
        worthKnowledge: false,
        isMeeting: false,
        entities: {},
        topics: [],
        project: null,
        highlights: []
      });
      return "not_worth";
    }

    // 提取可能的项目名称
    let inferredProject: string | null = null;
    if (session.appNames.includes("Code") || session.appNames.includes("Visual Studio Code")) {
      const match = sampleOcr.match(/([a-zA-Z0-9_-]+)\s*[-—]\s*(?:Visual Studio Code|Code)/i);
      if (match && match[1]) inferredProject = match[1];
    } else if (sampleOcr.toLowerCase().includes("obsidian-wechat-converter")) {
      inferredProject = "obsidian-wechat-converter";
    } else if (sampleOcr.toLowerCase().includes("otus")) {
      inferredProject = "otus";
    }

    let inferredTitle = `在 ${topApp} 中专注操作`;
    if (sampleOcr) {
      // 深度清洗 macOS 菜单栏与状态栏噪声
      const cleaned = sampleOcr
        .replace(/(?:File|Edit|View|Window|Help|History|Bookmarks|Profiles|Tab|Assistant)[\s:：]*/gi, " ")
        .replace(/(?:文件|编辑|视图|窗口|帮助|历史|书签|标签页)[\s:：]*/g, " ")
        .replace(/\d+\.?\d*[KMGT]?\/S/gi, " ")
        .replace(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+/gi, " ")
        .replace(/[^\u4e00-\u9fa5a-zA-Z0-9_\-\.\:\/ ]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (cleaned.length >= 4) {
        inferredTitle = `${topApp}: ${cleaned.slice(0, 26)}`;
      }
    }

    this.store.setSessionAnalysis(session.id, {
      status: "analyzed",
      title: inferredTitle,
      description: `在 ${realApps.join("、") || topApp} 中持续操作，捕获 ${ocrSnippets.length} 个屏幕帧（离线启发式兜底）。`,
      model: "offline-heuristic",
      worthMemory: false,
      worthKnowledge: false,
      isMeeting: false,
      entities: {},
      topics: realApps.map((a) => a.toLowerCase()),
      project: inferredProject,
      highlights: ocrSnippets.slice(0, 3).map((s) => s.slice(0, 60))
    });
    return "analyzed";
  }

  private async callLLMWithRetry(
    systemPrompt: string,
    userPrompt: string,
    model: string,
    maxRetries: number = 3
  ): Promise<string> {
    let lastError: any;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.callLLM(systemPrompt, userPrompt, model);
      } catch (err: any) {
        lastError = err;
        const msg = String(err?.message || err);

        // 如果是账户余额耗尽（0额度），重试无法解决，直接抛出由离线启发式分析接管
        const isQuotaExhausted =
          msg.toLowerCase().includes("credits exhausted") ||
          msg.toLowerCase().includes("insufficient_quota") ||
          msg.toLowerCase().includes("quota exceeded");

        // 仅对瞬时并发限频、网关错误或网络闪断执行重试与指数退避
        const isRateLimit =
          !isQuotaExhausted &&
          (msg.includes("429") ||
            msg.toLowerCase().includes("rate limit") ||
            msg.toLowerCase().includes("too many requests"));
        const isGateway =
          msg.includes("500") ||
          msg.includes("502") ||
          msg.includes("503") ||
          msg.includes("504");
        const isNetwork =
          msg.includes("ECONNRESET") ||
          msg.includes("ETIMEDOUT") ||
          msg.includes("fetch failed") ||
          msg.includes("AbortError");

        const isRetryable = isRateLimit || isGateway || isNetwork;
        if (!isRetryable || attempt >= maxRetries) {
          throw err;
        }

        const backoffMs = Math.round(1500 * Math.pow(2, attempt) + Math.random() * 500);
        console.warn(
          `[ActivityAnalyzer] LLM call transiently failed (attempt ${attempt + 1}/${maxRetries + 1}): ${msg.slice(0, 100)}. Retrying in ${backoffMs}ms...`
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    throw lastError;
  }

  private async callLLM(systemPrompt: string, userPrompt: string, model: string): Promise<string> {
    const apiBase = this.config.analysisApiBase || this.config.llmApiBase;
    const apiKey = this.config.analysisApiKey !== undefined ? this.config.analysisApiKey : this.config.llmApiKey;
    const url = `${apiBase.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature: 0.1,
          response_format: { type: "json_object" }
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`LLM HTTP ${res.status}: ${errText}`);
      }

      const data = await res.json() as any;
      return data.choices?.[0]?.message?.content || "";
    } finally {
      clearTimeout(timeout);
    }
  }

  private cleanAndParseJSON(raw: string): any {
    try {
      const trimmed = raw.trim();
      const match = trimmed.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  private normalizeEntities(raw: any): Record<string, any> {
    if (!raw || typeof raw !== "object") return {};
    return {
      prs: Array.isArray(raw.prs) ? raw.prs.slice(0, 20) : [],
      issues: Array.isArray(raw.issues) ? raw.issues.slice(0, 20) : [],
      commits: Array.isArray(raw.commits) ? raw.commits.slice(0, 20) : [],
      people: Array.isArray(raw.people) ? raw.people.slice(0, 20) : [],
      identifiers: Array.isArray(raw.identifiers) ? raw.identifiers.slice(0, 30) : [],
      repos: Array.isArray(raw.repos) ? raw.repos.slice(0, 10) : [],
      versions: Array.isArray(raw.versions) ? raw.versions.slice(0, 10) : [],
      events: Array.isArray(raw.events) ? raw.events.slice(0, 10) : [],
      decisions: Array.isArray(raw.decisions) ? raw.decisions.slice(0, 10) : [],
      urls: Array.isArray(raw.urls) ? raw.urls.slice(0, 30) : []
    };
  }
}
