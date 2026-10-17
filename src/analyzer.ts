import { ActivityStore } from "./store.ts";
import type { ActivitySession } from "./store.ts";
import { defaultConfig } from "./config.ts";
import type { OtusConfig } from "./config.ts";
import { redactSensitiveText } from "./redactor.ts";

const OTUS_ANALYZER_SYSTEM_PROMPT = `You are an activity analyzer for a desktop assistant. You analyze a work session from a person's computer (OCR text, apps used, browser visits, window titles) and produce a structured JSON summary.

Produce a JSON object with this shape:
{
  "worth": boolean,                    // true if this session contains real work, focus, communication, or learning
  "title": string,                     // ONE clear phrase (<= 80 chars) describing the primary activity. Concrete, specific. e.g. "Review WeChat article structure spec"
  "description": string,               // 1-2 concise sentences (<= 240 chars) summarizing what actually happened and any key outcome
  "project": string | null,            // inferred project/repo slug if clearly identifiable (e.g. "obsidian-wechat-converter", "otus"), or null
  "topics": string[],                  // 2-5 specific lowercase tags (e.g. ["wechat", "markdown", "theme"])
  "highlights": string[],              // 1-4 bullet points of concrete actions/outcomes (<= 120 chars each)
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
  "memoryCandidates": [
    {
      "type": "project" | "feedback" | "reference" | "user",
      "content": string,
      "why": string
    }
  ],
  "worthKnowledge": boolean,           // reusable knowledge (docs, APIs, code techniques)
  "isMeeting": boolean                 // true if this session was a sync meeting (Zoom/Meet/Teams/Feishu call)
}

Rules:
- "worth" must be false for idle scrolling, random browsing, system idle, transient app switches, or empty OCR.
- Be specific. Prefer "Merged PR #282 (activity-recorder service) into main" over "Worked on project".
- Every entity you list MUST appear verbatim in the OCR/events/visits. Never invent a PR number, person, version, or URL.
- Identifiers: only things a technical reader would recognize as named code/config. Skip common English words.
- If you can't attribute a project, set "project" to null. Do not guess.
- Return arrays even when empty — never omit keys in "entities".
- memoryCandidates: emit [] for normal sessions unless it's a durable fact/preference that survives 6+ months.
- When in doubt, emit [].
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
    const hasLlm = !!this.config.llmApiKey || this.config.llmApiBase.includes("localhost") || this.config.llmApiBase.includes("127.0.0.1");
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
        return "analyzed";
      }

      this.store.setSessionAnalysis(session.id, {
        status: "analyzed",
        title: parsed.title || "Focus Work",
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
  ): "analyzed" {
    const topApp = session.appNames[0] || "Desktop";
    const sampleOcr = ocrSnippets[0] || "";

    // 过滤条件：无任何按键/鼠标事件且无有效 OCR 内容，或者纯系统屏保/锁屏
    const isIdle =
      (session.eventCount === 0 && ocrSnippets.length === 0) ||
      (session.appNames.length > 0 &&
        session.appNames.every((a) =>
          ["loginwindow", "ScreenSaverEngine", "LockScreen"].includes(a)
        ));

    if (isIdle) {
      this.store.setSessionAnalysis(session.id, {
        status: "not_worth",
        title: `Idle / ${topApp}`,
        description: `Inactive session with 0 input events. Filtered via offline heuristic (${reason.slice(0, 100)}).`,
        model: "offline-heuristic",
        worthMemory: false,
        worthKnowledge: false,
        isMeeting: false,
        entities: {},
        topics: [topApp.toLowerCase()],
        project: null,
        highlights: []
      });
      return "analyzed";
    }

    // 提取可能的项目名称：从应用名称或 OCR 常见词中简单判断
    let inferredProject: string | null = null;
    if (session.appNames.includes("Code") || session.appNames.includes("Visual Studio Code")) {
      const match = sampleOcr.match(/([a-zA-Z0-9_-]+)\s*[-—]\s*(?:Visual Studio Code|Code)/i);
      if (match && match[1]) inferredProject = match[1];
    }

    const inferredTitle = sampleOcr
      ? `${topApp}: ${sampleOcr.slice(0, 60)}`
      : `Work in ${session.appNames.slice(0, 2).join(", ") || topApp}`;

    this.store.setSessionAnalysis(session.id, {
      status: "analyzed",
      title: inferredTitle,
      description: `Active session in ${session.appNames.join(", ") || topApp} with ${ocrSnippets.length} OCR frames captured (fallback: ${reason.slice(0, 100)}).`,
      model: "offline-heuristic",
      worthMemory: false,
      worthKnowledge: false,
      isMeeting: false,
      entities: {},
      topics: session.appNames.map((a) => a.toLowerCase()),
      project: inferredProject,
      highlights: ocrSnippets.slice(0, 3)
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
    const url = `${this.config.llmApiBase.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (this.config.llmApiKey) {
      headers["Authorization"] = `Bearer ${this.config.llmApiKey}`;
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
