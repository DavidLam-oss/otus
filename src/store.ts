import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 之前这里有一段 `node:sqlite` → `bun:sqlite` 的 try/catch 降级，已移除。
 *
 * 移除理由：
 * 1. 它不通向任何真实可运行路径。`package.json` 的启动脚本是
 *    `node --experimental-strip-types`，`--experimental-strip-types` 是 Node 专属
 *    flag，Bun 不认，所以 Bun 下连进程都起不来，这个 fallback 永远执行不到。
 * 2. 它兜不住任何错误。Node 里 `import("bun:sqlite")` 会再抛一次
 *    `Cannot find module 'bun:sqlite'`，把「node:sqlite 加载失败」这个真实原因
 *    盖成一条误导性的报错。
 * 3. 运行时基线是 Node 26+（AGENTS.md §2.2），`node:sqlite` 必然存在。
 *
 * 注意 `ActivityStore.db` 仍标为 `any`：`node:sqlite` 是实验性 API，
 * 各小版本的类型形状还在变，标注具体类型会让升级 Node 时产生大量无关报错。
 */

/** 安全解析 JSON：失败或空返回默认值，避免脏数据中断整表读取。 */
function safeJsonParse<T>(raw: any, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}

export interface ActivitySession {
  id: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  triggerKind: string;
  appNames: string[];
  eventCount: number;
  snapshotCount: number;
  totalBytes: number;
  analysisStatus: "pending" | "analyzed" | "not_worth" | "failed";
  analysisTitle: string | null;
  analysisDescription: string | null;
  analysisModel: string | null;
  analysisError: string | null;
  analyzedAt: number | null;
  worthMemory: boolean;
  worthKnowledge: boolean;
  isMeeting: boolean;
  storageTier: string;
  entities: Record<string, any>;
  topics: string[];
  project: string | null;
  highlights: string[];
  signals: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}

export interface ActivitySnapshot {
  id: string;
  sessionId: string;
  timestamp: number;
  filePath: string;
  width: number;
  height: number;
  sizeBytes: number;
  trigger: string;
  appName: string | null;
  windowTitle: string | null;
  hashHex: string | null;
  histogram: string | null;
  diffPct: number | null;
  storageTier: string;
  createdAt: number;
}

export interface ActivityOcrFrame {
  id: string;
  snapshotId: string;
  sessionId: string;
  text: string;
  charCount: number;
  tokenCount: number;
  createdAt: number;
}

export interface ActivityEvent {
  id: string;
  sessionId: string;
  timestamp: number;
  kind: string;
  appName: string | null;
  data: Record<string, any>;
  createdAt: number;
}

export interface ActivitySummary {
  id: string;
  kind: string;
  dateKey: string;
  summary: string | null;
  stats: Record<string, any>;
  model: string | null;
  isPartial: boolean;
  createdAt: number;
  updatedAt: number;
}

export class ActivityStore {
  public db: any;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.initTables();
  }

  /**
   * 显式关闭数据库连接。
   *
   * 长驻 daemon 用不到（进程退出时内核会回收），但两类场景需要：
   * 1. 短期 CLI 命令（`otus status` / `otus config`）——尽早释放 WAL 的 -shm/-wal，
   *    避免和 daemon 抢锁；
   * 2. 测试用例——同一个进程里连续开关多个库时，不关会一直持有文件句柄。
   */
  public close(): void {
    try {
      // 关库前主动 checkpoint，把 WAL 内容合并回主库，避免留下大的 -wal 文件
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // checkpoint 失败不影响关闭（如只读打开或已被别的连接持有）
    }
    this.db.close();
  }

  private initTables(): void {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS activity_sessions (
          id TEXT PRIMARY KEY,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          duration_ms INTEGER,
          trigger_kind TEXT NOT NULL DEFAULT 'idle',
          app_names TEXT NOT NULL DEFAULT '[]',
          event_count INTEGER NOT NULL DEFAULT 0,
          snapshot_count INTEGER NOT NULL DEFAULT 0,
          total_bytes INTEGER NOT NULL DEFAULT 0,
          analysis_status TEXT NOT NULL DEFAULT 'pending',
          analysis_title TEXT,
          analysis_description TEXT,
          analysis_model TEXT,
          analysis_error TEXT,
          analyzed_at INTEGER,
          worth_memory INTEGER NOT NULL DEFAULT 0,
          worth_knowledge INTEGER NOT NULL DEFAULT 0,
          is_meeting INTEGER NOT NULL DEFAULT 0,
          storage_tier TEXT NOT NULL DEFAULT 'hot',
          entities TEXT NOT NULL DEFAULT '{}',
          topics TEXT NOT NULL DEFAULT '[]',
          project TEXT,
          highlights TEXT NOT NULL DEFAULT '[]',
          signals TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activity_sessions_started_at ON activity_sessions(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_sessions_ended_at ON activity_sessions(ended_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_sessions_analysis_status ON activity_sessions(analysis_status);
      CREATE INDEX IF NOT EXISTS idx_activity_sessions_storage_tier ON activity_sessions(storage_tier);
      CREATE INDEX IF NOT EXISTS idx_activity_sessions_project ON activity_sessions(project);

      CREATE TABLE IF NOT EXISTS activity_snapshots (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          file_path TEXT NOT NULL,
          width INTEGER NOT NULL DEFAULT 0,
          height INTEGER NOT NULL DEFAULT 0,
          size_bytes INTEGER NOT NULL DEFAULT 0,
          trigger TEXT NOT NULL DEFAULT 'heartbeat',
          app_name TEXT,
          window_title TEXT,
          hash_hex TEXT,
          histogram TEXT,
          diff_pct REAL,
          storage_tier TEXT NOT NULL DEFAULT 'hot',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES activity_sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_activity_snapshots_session ON activity_snapshots(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_activity_snapshots_storage_tier ON activity_snapshots(storage_tier);

      CREATE TABLE IF NOT EXISTS activity_ocr_frames (
          id TEXT PRIMARY KEY,
          snapshot_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          text TEXT NOT NULL,
          char_count INTEGER NOT NULL DEFAULT 0,
          token_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (snapshot_id) REFERENCES activity_snapshots(id) ON DELETE CASCADE,
          FOREIGN KEY (session_id) REFERENCES activity_sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_activity_ocr_frames_session ON activity_ocr_frames(session_id);
      CREATE INDEX IF NOT EXISTS idx_activity_ocr_frames_snapshot ON activity_ocr_frames(snapshot_id);

      CREATE TABLE IF NOT EXISTS activity_events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          kind TEXT NOT NULL,
          app_name TEXT,
          data TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES activity_sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_activity_events_session ON activity_events(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_activity_events_kind ON activity_events(kind);

      CREATE TABLE IF NOT EXISTS activity_summaries (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          date_key TEXT NOT NULL,
          summary TEXT,
          stats TEXT NOT NULL DEFAULT '{}',
          model TEXT,
          is_partial INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(kind, date_key)
      );
      CREATE INDEX IF NOT EXISTS idx_activity_summaries_date ON activity_summaries(kind, date_key);
    `);

    // 幂等增量迁移：老库的 activity_sessions 没有 signals 列，CREATE TABLE IF NOT EXISTS
    // 不会给它补列。这里显式补，保证老库升级后也能用新字段。
    this.ensureColumn("activity_sessions", "signals", "signals TEXT NOT NULL DEFAULT '{}'");
  }

  /**
   * 幂等加列：列不存在才 ALTER TABLE ADD COLUMN。
   *
   * 并发注意：迁移发生在 initTables（进程启动早期、采集尚未开始时）。
   * daemon 正常运行期间库是热的，但启动期是我们独占的窗口期。
   * 为避免与极少数残留连接竞争，用 BEGIN IMMEDIATE 显式抢写锁，
   * 失败（已存在/被并发加过）即静默忽略。新列带 DEFAULT，SQLite 3.35+
   * 是纯元数据 O(1) 操作，不重写表。
   */
  private ensureColumn(table: string, column: string, ddl: string): void {
    try {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as any[];
      if (cols.some((c) => c.name === column)) return;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
        this.db.exec("COMMIT");
      } catch (e) {
        try { this.db.exec("ROLLBACK"); } catch {}
        // 并发下可能已被别的连接加过，重新检查一次
        const again = this.db.prepare(`PRAGMA table_info(${table})`).all() as any[];
        if (!again.some((c) => c.name === column)) throw e;
      }
    } catch (e) {
      console.warn(`[ActivityStore] ensureColumn(${table}.${column}) 失败：`, String((e as any)?.message || e));
    }
  }

  // Session CRUD
  public createSession(opts: { startedAt?: number; triggerKind?: string } = {}): ActivitySession {
    const id = `sess_${crypto.randomUUID()}`;
    const now = Date.now();
    const startedAt = opts.startedAt ?? now;
    const triggerKind = opts.triggerKind ?? "idle";

    this.db.prepare(`
      INSERT INTO activity_sessions (
        id, started_at, ended_at, duration_ms, trigger_kind, app_names,
        event_count, snapshot_count, total_bytes, analysis_status,
        worth_memory, worth_knowledge, is_meeting, storage_tier,
        created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, ?, '[]', 0, 0, 0, 'pending', 0, 0, 0, 'hot', ?, ?)
    `).run(id, startedAt, triggerKind, now, now);

    return this.getSession(id)!;
  }

  public getSession(id: string): ActivitySession | null {
    const row = this.db.prepare(`SELECT * FROM activity_sessions WHERE id = ?`).get(id) as any;
    return row ? this.mapSessionRow(row) : null;
  }

  /**
   * 把一个会话合并进另一个会话（对齐 Alma 的 mergeSessionInto）。
   *
   * 用途：分析前的相邻碎片聚合。碎片是采集层的正常产物，
   * 但逐个送进 LLM 会得到「同一件事被拆成几十条」的失真报告。
   *
   * @param sourceId 被合并掉的会话（会被删除）
   * @param targetId 保留的目标会话
   * @returns 是否执行了合并
   */
  public mergeSessionInto(sourceId: string, targetId: string): boolean {
    if (sourceId === targetId) return false;
    const source = this.getSession(sourceId);
    const target = this.getSession(targetId);
    if (!source || !target) return false;
    // 目标会话若仍在采集中则不合并，避免与写入竞争
    // （已分析的会话允许作为合并目标，调用方需在合并后重置分析状态）

    const now = Date.now();
    const mergedStart = Math.min(target.startedAt, source.startedAt);
    const mergedEnd = Math.max(
      target.endedAt ?? target.startedAt,
      source.endedAt ?? source.startedAt
    );
    const mergedApps = [...new Set([...target.appNames, ...source.appNames])];

    // 整段合并涉及 6+ 次写操作，必须原子化：
    // 中途崩溃会留下「子记录已改挂、父会话聚合字段未更新」或「源会话未删除」的脏状态，
    // 而这种脏状态没有任何巡检能自动修复。用 BEGIN IMMEDIATE 直接拿写锁，
    // 避免 WAL 下 BEGIN DEFERRED 在首次写时才升级锁、可能直接报 SQLITE_BUSY。
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      // 1. 关联数据改挂到目标会话
      this.db.prepare(`UPDATE activity_events SET session_id = ? WHERE session_id = ?`).run(targetId, sourceId);
      this.db.prepare(`UPDATE activity_snapshots SET session_id = ? WHERE session_id = ?`).run(targetId, sourceId);
      this.db.prepare(`UPDATE activity_ocr_frames SET session_id = ? WHERE session_id = ?`).run(targetId, sourceId);

      // 2. 重算目标会话的聚合字段
      const eventCount = (this.db.prepare(
        `SELECT COUNT(*) AS c FROM activity_events WHERE session_id = ?`
      ).get(targetId) as any)?.c ?? 0;
      const snapStats = this.db.prepare(
        `SELECT COUNT(*) AS c, COALESCE(SUM(size_bytes), 0) AS bytes FROM activity_snapshots WHERE session_id = ?`
      ).get(targetId) as any;

      this.db.prepare(`
        UPDATE activity_sessions
        SET started_at = ?, ended_at = ?, duration_ms = ?, app_names = ?,
            event_count = ?, snapshot_count = ?, total_bytes = ?, updated_at = ?
        WHERE id = ?
      `).run(
        mergedStart,
        mergedEnd,
        mergedEnd - mergedStart,
        JSON.stringify(mergedApps),
        eventCount,
        snapStats?.c ?? 0,
        snapStats?.bytes ?? 0,
        now,
        targetId
      );

      // 3. 删除被合并的会话
      this.db.prepare(`DELETE FROM activity_sessions WHERE id = ?`).run(sourceId);

      // 4. 合并后重新派生 signals（合并体的事件集合已变，旧 signals 失效）
      // 放在事务内：它写的是同一个 target 行的 signals 字段，失败应一起回滚
      this.updateSessionSignals(targetId);

      this.db.exec("COMMIT;");
      return true;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // 回滚本身失败（如连接已坏）时保留原始错误，不要用回滚错误覆盖它
      }
      throw err;
    }
  }

  /**
   * 派生会话的行为信号（纯计算，无新采集），写入 signals.activity。
   *
   * 目前计算：
   *   - focusSwitches: 相邻 app_focus 事件 bundleId 变化的次数（切换频率）
   *   - clickCount / clickRate: 点击数 / 每分钟点击数（交互密度）
   *   - activeSeconds: 会话时长（秒）
   *   - eventCount: 事件总数
   *   - 切换质量（见下方注释）：revisitSwitches / newAppSwitches /
   *     veryShortSwitches / avgDwellMs / distinctApps / dominantAppShare /
   *     switchesPerMinute
   *
   * 只写 signals.activity，保留 signals 中其它已有字段（如后续的 focusWindows/keywords）。
   * 注意：activity 下的字段名是 summarizer 消费的契约（src/summarizer.ts 的
   * item.activity），改名要两边一起改。
   */
  public updateSessionSignals(sessionId: string): void {
    const sess = this.getSession(sessionId);
    if (!sess) return;

    // 只取 app_focus 与 click 两类事件：这是本函数唯一的输入。
    // 不用 listEvents(sessionId, N) —— 它按 timestamp ASC 取前 N 条，
    // 会话事件超过 N 时会把**尾部**静默丢掉，导致切换数系统性低估。
    // 这里直接在 SQL 里过滤，长会话也不会失真。
    const events = this.db.prepare(`
      SELECT kind, timestamp, app_name, data
      FROM activity_events
      WHERE session_id = ? AND kind IN ('app_focus', 'click')
      ORDER BY timestamp ASC
    `).all(sessionId) as any[];

    let clickCount = 0;
    let lastFocusKey: string | null = null;
    let focusSwitches = 0;

    // 切换质量分析：区分「有目的的工具链回访」和「真正被打断」。
    //
    // 为什么要区分：做网站/改代码时，Chrome 看效果 → 编辑器改代码 → 终端跑构建
    // 是一个每 20-30 秒循环一次的正常工作流，切换次数极高但全程同一件事；
    // 而「写文档 → 切微信回消息 → 切回来」虽然也只算一次切换，性质却是打断。
    // 只看 focusSwitches 会把前者误判成「注意力被切碎」。
    //
    // 判定依据：
    //   - revisitSwitches: 切到的 App 在本会话里访问过（回访）→ 工具链切换，不算碎片
    //   - newAppSwitches:  切到本会话里第一次出现的 App     → 探索/打断，计入碎片
    //   - veryShortSwitches: 停留 < 5 秒就切走（扫一眼就走）
    //   - avgDwellMs: 每次切换后的平均停留时长
    //   - distinctApps: 本会话触碰过的不同 App 数
    //   - dominantAppShare: 主 App 占用的**时长**比例（越集中越说明在专注）
    //
    // 注意 dominantAppShare 的口径曾是「焦点轮次占比」（topVisits/totalVisits），
    // 但它与实测不符：Chrome 停 30 秒看效果 + 编辑器停 60 秒改代码循环时，
    // Chrome 轮次更多，会得出「主 App 是 Chrome」的误导结论。
    // summarizer 提示词里「dominantAppShare 低才可能是真碎片」也正基于时长直觉，
    // 所以这里必须按停留时长算。
    const appVisitCount = new Map<string, number>();
    const appDwellMs = new Map<string, number>();
    const switchTimestamps: number[] = [];
    let lastFocusKeyForDwell: string | null = null;
    let lastFocusTsForDwell = 0;
    let revisitSwitches = 0;
    let newAppSwitches = 0;
    let lastFocusTs = 0;
    let veryShortSwitches = 0;

    for (const ev of events) {
      if (ev.kind === "click") {
        clickCount++;
        continue;
      }
      if (ev.kind !== "app_focus") continue;

      // data 列是 JSON 字符串（裸 SQL 取出的原始值），要自己解析。
      // 解析失败时退回 app_name，不能让整条事件被丢掉。
      let bundleId: string | undefined;
      try {
        const d = typeof ev.data === "string" ? safeJsonParse<any>(ev.data, {}) : ev.data;
        if (d && typeof d === "object") bundleId = d.bundleId;
      } catch {
        // 忽略非法 JSON，走 app_name 兜底
      }
      const key = String(bundleId ?? ev.app_name ?? "");
      if (!key) continue;

      const seen = appVisitCount.get(key) ?? 0;
      appVisitCount.set(key, seen + 1);

      // 时长累加：把「上一个 App 从它被聚焦到此刻」这一整段记给它。
      // 首条 app_focus 只有时间戳、没有上一段，故从第二条开始累计；
      // 会话尾段（最后一次切换 → ended_at）在循环外补。
      if (lastFocusKeyForDwell !== null && ev.timestamp > lastFocusTsForDwell) {
        appDwellMs.set(
          lastFocusKeyForDwell,
          (appDwellMs.get(lastFocusKeyForDwell) ?? 0) + (ev.timestamp - lastFocusTsForDwell)
        );
      }
      lastFocusKeyForDwell = key;
      lastFocusTsForDwell = ev.timestamp;

      if (lastFocusKey !== null && key !== lastFocusKey) {
        focusSwitches++;
        if (seen > 0) revisitSwitches++;
        else newAppSwitches++;
        if (lastFocusTs > 0) {
          switchTimestamps.push(lastFocusTs);
          if (ev.timestamp - lastFocusTs < 5000) veryShortSwitches++;
        }
        lastFocusTs = ev.timestamp;
      } else if (lastFocusKey === null) {
        lastFocusTs = ev.timestamp;
      }
      lastFocusKey = key;
    }

    const distinctApps = appVisitCount.size;
    // 尾段补齐：最后一次聚焦到会话结束的时长记给最后那个 App。
    if (lastFocusKeyForDwell !== null) {
      const sessionEnd = sess.endedAt ?? sess.startedAt + (sess.durationMs ?? 0);
      if (sessionEnd > lastFocusTsForDwell) {
        appDwellMs.set(
          lastFocusKeyForDwell,
          (appDwellMs.get(lastFocusKeyForDwell) ?? 0) + (sessionEnd - lastFocusTsForDwell)
        );
      }
    }
    let topDwell = 0;
    let totalDwell = 0;
    for (const v of appDwellMs.values()) {
      totalDwell += v;
      if (v > topDwell) topDwell = v;
    }
    // 时长口径；无任何时长数据时退回轮次口径，避免全 0。
    let dominantAppShare: number;
    if (totalDwell > 0) {
      dominantAppShare = Math.round((topDwell / totalDwell) * 100) / 100;
    } else {
      let topVisits = 0;
      let totalVisits = 0;
      for (const v of appVisitCount.values()) {
        totalVisits += v;
        if (v > topVisits) topVisits = v;
      }
      dominantAppShare = totalVisits > 0 ? Math.round((topVisits / totalVisits) * 100) / 100 : 0;
    }
    // 平均停留：用真实累计的 App 停留时长 ÷ 聚焦段数。
    // 旧实现是 durationMs / (switchTimestamps.length + 1)，分母只在
    // lastFocusTs > 0 时才 +1，首段漏计；且 durationMs 含首段空闲，
    // 会让结果系统性偏大。改用 appDwellMs 的真实累计值。
    const avgDwellMs = appDwellMs.size > 0
      ? Math.round(totalDwell / appDwellMs.size)
      : (sess.durationMs ?? 0);

    const activeSeconds = Math.max(0, Math.round((sess.durationMs ?? 0) / 1000));
    const minutes = Math.max(1, Math.round((sess.durationMs ?? 0) / 60000));
    const clickRate = Math.round((clickCount / minutes) * 10) / 10;
    // 每分钟切换次数：比裸的 focusSwitches 更能横向比较长短会话
    const switchesPerMinute = Math.round((focusSwitches / minutes) * 10) / 10;

    const prev = sess.signals && typeof sess.signals === "object" ? sess.signals : {};
    const next = {
      ...prev,
      activity: {
        focusSwitches,
        clickCount,
        clickRate,
        activeSeconds,
        eventCount: events.length,
        // 切换质量（区分工具链循环 vs 真正打断）
        revisitSwitches,
        newAppSwitches,
        veryShortSwitches,
        avgDwellMs,
        distinctApps,
        dominantAppShare,
        switchesPerMinute
      }
    };
    this.db
      .prepare(`UPDATE activity_sessions SET signals = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(next), Date.now(), sessionId);
  }

  /**
   * 把会话重置为待分析状态，清除上一次的分析产物。
   *
   * 用途：会话合并后，聚合体的内容已与原分析结果不符，必须重新分析。
   */
  public resetSessionAnalysis(id: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE activity_sessions
      SET analysis_status = 'pending',
          analysis_title = NULL,
          analysis_description = NULL,
          analysis_model = NULL,
          analysis_error = NULL,
          analyzed_at = NULL,
          worth_memory = 0,
          worth_knowledge = 0,
          is_meeting = 0,
          entities = '{}',
          topics = '[]',
          project = NULL,
          highlights = '[]',
          signals = '{}',
          updated_at = ?
      WHERE id = ?
    `).run(now, id);
  }

  public closeSession(id: string, endedAt: number = Date.now()): void {
    const session = this.getSession(id);
    if (!session) return;
    const end = Math.max(endedAt, session.startedAt);
    const durationMs = end - session.startedAt;
    const now = Date.now();

    this.db.prepare(`
      UPDATE activity_sessions
      SET ended_at = ?, duration_ms = ?, updated_at = ?
      WHERE id = ?
    `).run(end, durationMs, now, id);

    // 会话闭合时派生一次行为信号（纯计算，失败不影响会话关闭）
    try {
      this.updateSessionSignals(id);
    } catch (e) {
      console.warn("[ActivityStore] updateSessionSignals 失败：", String((e as any)?.message || e));
    }
  }

  public listSessions(opts: { since?: number; until?: number; limit?: number; analysisStatus?: string | string[]; analysisModel?: string } = {}): ActivitySession[] {
    const clauses: string[] = [];
    const params: any[] = [];

    if (opts.since !== undefined) {
      clauses.push("started_at >= ?");
      params.push(opts.since);
    }
    if (opts.until !== undefined) {
      clauses.push("started_at < ?");
      params.push(opts.until);
    }
    if (opts.analysisStatus) {
      if (Array.isArray(opts.analysisStatus)) {
        if (opts.analysisStatus.length > 0) {
          const placeholders = opts.analysisStatus.map(() => "?").join(", ");
          clauses.push(`analysis_status IN (${placeholders})`);
          params.push(...opts.analysisStatus);
        }
      } else {
        clauses.push("analysis_status = ?");
        params.push(opts.analysisStatus);
      }
    }
    if (opts.analysisModel) {
      clauses.push("analysis_model = ?");
      params.push(opts.analysisModel);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 2000);
    params.push(limit);

    const rows = this.db.prepare(`
      SELECT * FROM activity_sessions
      ${where}
      ORDER BY started_at ASC
      LIMIT ?
    `).all(...params) as any[];

    return rows.map((r) => this.mapSessionRow(r));
  }

  public listOpenSessions(): ActivitySession[] {
    const rows = this.db.prepare(`SELECT * FROM activity_sessions WHERE ended_at IS NULL`).all() as any[];
    return rows.map((r) => this.mapSessionRow(r));
  }

  /** 仅更新会话标题（用于全局归纳阶段修正被侧边栏项目名带偏的标题） */
  public updateSessionTitle(id: string, title: string): void {
    this.db
      .prepare(`UPDATE activity_sessions SET analysis_title = ?, updated_at = ? WHERE id = ?`)
      .run(title, Date.now(), id);
  }

  public countAnalyzedSessionsSince(since: number): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM activity_sessions
      WHERE analysis_status = 'analyzed' AND (analyzed_at > ? OR updated_at > ?)
    `).get(since, since) as { count: number } | undefined;
    return row?.count || 0;
  }

  public setSessionAnalysis(
    id: string,
    analysis: {
      status: "analyzed" | "not_worth" | "failed";
      title?: string | null;
      description?: string | null;
      model?: string | null;
      error?: string | null;
      worthMemory?: boolean;
      worthKnowledge?: boolean;
      isMeeting?: boolean;
      entities?: Record<string, any>;
      topics?: string[];
      project?: string | null;
      highlights?: string[];
    }
  ): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE activity_sessions
      SET analysis_status = ?,
          analysis_title = ?,
          analysis_description = ?,
          analysis_model = ?,
          analysis_error = ?,
          analyzed_at = ?,
          worth_memory = ?,
          worth_knowledge = ?,
          is_meeting = ?,
          entities = ?,
          topics = ?,
          project = ?,
          highlights = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      analysis.status,
      analysis.title ?? null,
      analysis.description ?? null,
      analysis.model ?? null,
      analysis.error ?? null,
      now,
      analysis.worthMemory ? 1 : 0,
      analysis.worthKnowledge ? 1 : 0,
      analysis.isMeeting ? 1 : 0,
      JSON.stringify(analysis.entities ?? {}),
      JSON.stringify(analysis.topics ?? []),
      analysis.project ?? null,
      JSON.stringify(analysis.highlights ?? []),
      now,
      id
    );
  }

  // Events
  public insertEvent(sessionId: string, event: { timestamp: number; kind: string; appName?: string | null; data?: Record<string, any> }): void {
    const id = `ev_${crypto.randomUUID()}`;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO activity_events (id, session_id, timestamp, kind, app_name, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, sessionId, event.timestamp, event.kind, event.appName ?? null, JSON.stringify(event.data ?? {}), now);

    // 更新 session 统计与 app_names
    const session = this.getSession(sessionId);
    if (session) {
      const apps = new Set(session.appNames);
      if (event.appName && event.appName.trim()) apps.add(event.appName.trim());
      this.db.prepare(`
        UPDATE activity_sessions
        SET event_count = event_count + 1, app_names = ?, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify([...apps]), now, sessionId);
    }
  }

  public listEvents(sessionId: string, limit: number = 200): ActivityEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM activity_events WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?
    `).all(sessionId, limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      timestamp: r.timestamp,
      kind: r.kind,
      appName: r.app_name,
      data: safeJsonParse<any>(r.data, {}),
      createdAt: r.created_at
    }));
  }

  // Snapshots & OCR
  public insertSnapshot(sessionId: string, snap: {
    timestamp: number;
    filePath: string;
    width?: number;
    height?: number;
    sizeBytes?: number;
    trigger?: string;
    appName?: string | null;
    windowTitle?: string | null;
    hashHex?: string | null;
    histogram?: string | null;
    diffPct?: number | null;
  }): string {
    const id = `snap_${crypto.randomUUID()}`;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO activity_snapshots (
        id, session_id, timestamp, file_path, width, height, size_bytes,
        trigger, app_name, window_title, hash_hex, histogram, diff_pct,
        storage_tier, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hot', ?)
    `).run(
      id, sessionId, snap.timestamp, snap.filePath, snap.width ?? 0, snap.height ?? 0,
      snap.sizeBytes ?? 0, snap.trigger ?? "heartbeat", snap.appName ?? null,
      snap.windowTitle ?? null, snap.hashHex ?? null, snap.histogram ?? null,
      snap.diffPct ?? null, now
    );

    const session = this.getSession(sessionId);
    if (session) {
      const apps = new Set(session.appNames);
      if (snap.appName && snap.appName.trim()) apps.add(snap.appName.trim());
      this.db.prepare(`
        UPDATE activity_sessions
        SET snapshot_count = snapshot_count + 1, total_bytes = total_bytes + ?, app_names = ?, updated_at = ?
        WHERE id = ?
      `).run(snap.sizeBytes ?? 0, JSON.stringify([...apps]), now, sessionId);
    }

    return id;
  }

  // ── 分层存储（对齐 Alma 的 hot / warm / cold 三级轮转） ──
  // 轮转器需要按 tier 取快照、降级、以及重压缩后回写尺寸与体积。

  public listSnapshotsForTier(tier: "hot" | "warm" | "cold", limit: number = 500): Array<{
    id: string;
    filePath: string;
    sizeBytes: number;
    width: number;
    height: number;
    timestamp: number;
  }> {
    const rows = this.db.prepare(`
      SELECT id, file_path, size_bytes, width, height, timestamp
      FROM activity_snapshots
      WHERE storage_tier = ?
      ORDER BY timestamp ASC
      LIMIT ?
    `).all(tier, limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      filePath: r.file_path,
      sizeBytes: r.size_bytes || 0,
      width: r.width || 0,
      height: r.height || 0,
      timestamp: r.timestamp
    }));
  }

  public setSnapshotTier(id: string, tier: "hot" | "warm" | "cold"): void {
    this.db.prepare(`UPDATE activity_snapshots SET storage_tier = ? WHERE id = ?`).run(tier, id);
  }

  /** 重压缩后回写：体积、像素尺寸、文件路径（png→jpg 时会变）与新的 tier */
  public updateSnapshotAfterRecompress(
    id: string,
    info: { sizeBytes: number; width: number; height: number; filePath: string; tier: "hot" | "warm" | "cold" }
  ): void {
    const row = this.db.prepare(`SELECT size_bytes FROM activity_snapshots WHERE id = ?`).get(id) as any;
    const oldSize = row?.size_bytes || 0;
    this.db.prepare(`
      UPDATE activity_snapshots
      SET size_bytes = ?, width = ?, height = ?, file_path = ?, storage_tier = ?
      WHERE id = ?
    `).run(info.sizeBytes, info.width, info.height, info.filePath, info.tier, id);

    // 同步会话的 total_bytes，让容量统计保持准确
    const delta = info.sizeBytes - oldSize;
    if (delta !== 0) {
      this.db.prepare(`
        UPDATE activity_sessions
        SET total_bytes = MAX(0, total_bytes + ?)
        WHERE id = (SELECT session_id FROM activity_snapshots WHERE id = ?)
      `).run(delta, id);
    }
  }

  public deleteSnapshot(id: string): void {
    const row = this.db.prepare(`SELECT size_bytes, session_id FROM activity_snapshots WHERE id = ?`).get(id) as any;
    this.db.prepare(`DELETE FROM activity_snapshots WHERE id = ?`).run(id);
    if (row) {
      this.db.prepare(`
        UPDATE activity_sessions
        SET total_bytes = MAX(0, total_bytes - ?)
        WHERE id = ?
      `).run(row.size_bytes || 0, row.session_id);
    }
  }

  /** 全部快照文件的账面总占用（用于容量水位线判断） */
  public totalStorageBytes(): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS total FROM activity_snapshots`).get() as any;
    return row?.total || 0;
  }

  public insertOcrFrame(snapshotId: string, sessionId: string, text: string): string {
    const id = `ocr_${crypto.randomUUID()}`;
    const now = Date.now();
    const charCount = text.length;
    const tokenCount = Math.ceil(charCount / 4);
    this.db.prepare(`
      INSERT INTO activity_ocr_frames (id, snapshot_id, session_id, text, char_count, token_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, snapshotId, sessionId, text, charCount, tokenCount, now);
    return id;
  }

  public listOcrForSession(sessionId: string, limit: number = 20): ActivityOcrFrame[] {
    const rows = this.db.prepare(`
      SELECT * FROM activity_ocr_frames WHERE session_id = ? ORDER BY created_at ASC LIMIT ?
    `).all(sessionId, limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      snapshotId: r.snapshot_id,
      sessionId: r.session_id,
      text: r.text,
      charCount: r.char_count,
      tokenCount: r.token_count,
      createdAt: r.created_at
    }));
  }

  /**
   * 按 App 统计单会话内的停留时长。
   *
   * 原本用 listEvents(sessionId, 500)，超过 500 事件的会话尾部会被静默截断，
   * 导致最后一个 App 的时长偏小甚至消失（实测单会话最长 1258 事件）。
   * 这里改为一次性把需要的列捞全——只取 timestamp/kind/app_name，
   * 不解析 data JSON，内存开销远小于“事件数无上限”的直觉印象。
   *
   * 关键约束：单段计入时长必须有上限（maxSliceMs）。
   * 没有上限时，一个 App 只要在会话里“最后出现”，之后所有空白时间都记给它。
   * 实测 2026-10-24：UserNotificationCenter 全天只有 10 次聚焦、分散在 01:41–12:12，
   * 却被算出 44 分钟，直接挤进“主用 App”排行——而它只是系统通知面板。
   * 上限取空闲阈值（默认 30s）：超过它说明用户已经离开这块屏幕，
   * 这段时间不该归给任何 App，应该算作空闲。
   */
  public perAppDurationsForSession(sessionId: string, maxSliceMs?: number): Map<string, number> {
    const events = this.db
      .prepare(
        `SELECT timestamp, kind, app_name FROM activity_events
         WHERE session_id = ? ORDER BY timestamp ASC`
      )
      .all(sessionId) as any[];
    const session = this.getSession(sessionId);
    const totalMs = session?.durationMs ?? 0;
    const map = new Map<string, number>();

    // 缺省上限 30s，与 config.idleThresholdMs 的默认值一致。
    // 之所以在这里给默认值而不是强制传参：本方法是热路径，
    // 且 store 层不该反向依赖 config 模块（会造成循环引用）。
    const cap = maxSliceMs && maxSliceMs > 0 ? maxSliceMs : 30000;

    // 事件过少的会话不能整段记给某个 App。
    // 实测：一个只有 1 个 UserNotificationCenter 事件的会话被记了 4.5 分钟，
    // 另一个同样只有 1 个事件的会话被记了 5.0 分钟，合计把系统通知面板
    // 顶到“主用 App”第 2 名。真实可归属时长不会超过「事件数 × 单段上限」，
    // 这里按事件数封顶，避免单事件会话吞掉整段会话时长。
    if (events.length === 0) {
      if (session?.appNames?.length) {
        map.set(session.appNames[0], Math.min(totalMs, cap));
      }
      return map;
    }

    let currentApp = events[0].app_name || "Unknown";
    let lastTs = events[0].timestamp;

    for (let i = 1; i < events.length; i++) {
      const ev = events[i];
      // 单段最多记 cap 毫秒：间隔超长说明用户已离开，余下时间不计给任何 App
      const dur = Math.min(cap, Math.max(0, ev.timestamp - lastTs));
      map.set(currentApp, (map.get(currentApp) ?? 0) + dur);
      if (ev.app_name) currentApp = ev.app_name;
      lastTs = ev.timestamp;
    }

    if (session?.endedAt) {
      // 尾段同理：会话结束后到最后一个事件之间的空白不整段归给最后一个 App
      const rem = Math.min(cap, Math.max(0, session.endedAt - lastTs));
      map.set(currentApp, (map.get(currentApp) ?? 0) + rem);
    }

    return map;
  }

  // Summaries
  public upsertSummary(summary: {
    kind: string;
    dateKey: string;
    summary: string | null;
    stats: Record<string, any>;
    model?: string | null;
    isPartial?: boolean;
  }): void {
    const id = `${summary.kind}:${summary.dateKey}`;
    const now = Date.now();
    const existing = this.db.prepare(`SELECT * FROM activity_summaries WHERE kind = ? AND date_key = ?`).get(summary.kind, summary.dateKey);

    if (existing) {
      this.db.prepare(`
        UPDATE activity_summaries
        SET summary = ?, stats = ?, model = ?, is_partial = ?, updated_at = ?
        WHERE kind = ? AND date_key = ?
      `).run(
        summary.summary ?? null,
        JSON.stringify(summary.stats ?? {}),
        summary.model ?? null,
        summary.isPartial ? 1 : 0,
        now,
        summary.kind,
        summary.dateKey
      );
    } else {
      this.db.prepare(`
        INSERT INTO activity_summaries (id, kind, date_key, summary, stats, model, is_partial, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        summary.kind,
        summary.dateKey,
        summary.summary ?? null,
        JSON.stringify(summary.stats ?? {}),
        summary.model ?? null,
        summary.isPartial ? 1 : 0,
        now,
        now
      );
    }
  }

  public getSummary(kind: string, dateKey: string): ActivitySummary | null {
    const row = this.db.prepare(`SELECT * FROM activity_summaries WHERE kind = ? AND date_key = ?`).get(kind, dateKey) as any;
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      dateKey: row.date_key,
      summary: row.summary,
      stats: safeJsonParse<any>(row.stats, {}),
      model: row.model,
      isPartial: row.is_partial === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapSessionRow(r: any): ActivitySession {
    return {
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      durationMs: r.duration_ms,
      triggerKind: r.trigger_kind,
      appNames: safeJsonParse<any[]>(r.app_names, []),
      eventCount: r.event_count,
      snapshotCount: r.snapshot_count,
      totalBytes: r.total_bytes,
      analysisStatus: r.analysis_status,
      analysisTitle: r.analysis_title,
      analysisDescription: r.analysis_description,
      analysisModel: r.analysis_model,
      analysisError: r.analysis_error,
      analyzedAt: r.analyzed_at,
      worthMemory: r.worth_memory === 1,
      worthKnowledge: r.worth_knowledge === 1,
      isMeeting: r.is_meeting === 1,
      storageTier: r.storage_tier,
      entities: safeJsonParse<Record<string, any[]>>(r.entities, {}),
      topics: safeJsonParse<any[]>(r.topics, []),
      project: r.project,
      highlights: safeJsonParse<any[]>(r.highlights, []),
      signals: safeJsonParse(r.signals, {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }
}
