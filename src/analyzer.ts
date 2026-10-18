import { ActivityStore } from "./store.ts";
import type { ActivitySession } from "./store.ts";
import { defaultConfig } from "./config.ts";
import type { OtusConfig } from "./config.ts";
import { redactSensitiveText } from "./redactor.ts";

const OTUS_ANALYZER_SYSTEM_PROMPT = `你是一个桌面个人活动记录器的微会话深度分析器。你负责分析用户在电脑上的一个工作会话（OCR 识别文本、使用的 App、浏览器访问记录、窗口标题等），并输出结构化的 JSON 总结。

严格规则（Hard rules）：
1. 语言要求（极其重要）：
   - title、description、highlights 必须始终使用简体中文输出！即使 OCR 主要是英文代码或文档，也必须用精炼有力的中文短语进行总结。
   - 专有名词（如项目名、PR 编号、函数名、API、Git 分支、英文产品名等）保留原样，不要生硬汉化（如 "Obsidian", "PR #82", "ESLint", "Tailwind"）。
2. title 格式规范：
   - 必须是一句精炼具体的中文短语（不超过 30 个字），直击核心行动与产出。
   - 优秀示例：「Obsidian 插件发布 v2.11.0」、「调试微信文章列表缩进偏移」、「配置 Magpie 模型智能路由」、「重构 SQLite 数据存储层」。
   - 反面示例（严禁出现）：「在 Chrome 中浏览网页」、「处理项目」、「Coding in VS Code」、「测试」。
3. worth 过滤标准：
   - 如果该会话仅为系统锁屏（loginwindow / ScreenSaver / LockScreen）、无输入闲置挂机、随机刷网页摸鱼、或者 OCR 毫无实质操作内容，"worth" 必须设为 false。
4. 事实准则：
   - 绝对严禁编造任何事实。提到的 PR 号、Issue、Commit、版本号、人名必须在 OCR 或事件中原样出现。

输出的 JSON 格式规范：
{
  "worth": boolean,                    // 若为实质折腾/编码/深度阅读/沟通学习则为 true，无意义闲置或纯锁屏为 false
  "title": string,                     // 极简中文短语 (<= 30 字)，直击核心折腾内容
  "description": string,               // 1-2 句紧凑中文 (<= 120 字)，概括实际操作与关键产出
  "project": string | null,            // 推断的项目名称 slug（如 "obsidian-wechat-converter", "otus"），无法确认填 null
  "topics": string[],                  // 2-4 个精炼主题标签（如 ["发布", "eslint", "样式调试"]）
  "highlights": string[],              // 1-3 条具体行动/产出的中文要点 (<= 60 字/条)
  "entities": {
    "prs": [{"label": string, "ref"?: string, "repo"?: string, "url"?: string}],
    "issues": [{"label": string, "ref"?: string, "repo"?: string, "url"?: string}],
    "commits": [{"label": string, "ref"?: string, "repo"?: string, "url"?: string}],
    "people": [{"handle": string, "name"?: string}],
    "identifiers": string[],
    "repos": string[],
    "versions": string[],
    "events": string[],
    "decisions": string[],
    "urls": string[]
  },
  "memoryCandidates": [],
  "worthKnowledge": boolean,           // 是否包含可复用知识（技术方案、文档、踩坑经验）
  "isMeeting": boolean                 // 是否为音视频会议/通话
}
`;

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
      // 优先获取 pending 状态的会话；若未达到 limit，则补充分派失败 (failed) 的会话重新分析
      let targets = this.store.listSessions({ analysisStatus: "pending", limit });
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

  public async analyzeSession(session: ActivitySession): Promise<"analyzed" | "failed"> {
    // 1. 抽取该 session 的 OCR 抽稀片段 (最多 6 条, 每条 <= 400 字符)
    const ocrFrames = this.store.listOcrForSession(session.id, 20);
    const ocrSnippets: string[] = [];
    let lastSnippet = "";
    for (const frame of ocrFrames) {
      const clean = frame.text.replace(/\s+/g, " ").trim();
      if (clean && clean !== lastSnippet) {
        lastSnippet = clean;
        ocrSnippets.push(clean.slice(0, 400));
        if (ocrSnippets.length >= 6) break;
      }
    }

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
          project: parsed.project || null,
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
        project: parsed.project || null,
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
