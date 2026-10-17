import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

let SQLiteClass: any;
try {
  const mod = await import("node:sqlite");
  SQLiteClass = mod.DatabaseSync;
} catch {
  const mod = await import("bun:sqlite");
  SQLiteClass = class extends mod.Database {
    exec(sql: string) { return (this as any).run(sql); }
    prepare(sql: string) {
      const stmt = (this as any).query(sql);
      return {
        run: (...args: any[]) => stmt.run(...args),
        get: (...args: any[]) => stmt.get(...args),
        all: (...args: any[]) => stmt.all(...args)
      };
    }
  };
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
    this.db = new SQLiteClass(dbPath);
    this.initTables();
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
  }

  public listSessions(opts: { since?: number; until?: number; limit?: number; analysisStatus?: string | string[] } = {}): ActivitySession[] {
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
      data: JSON.parse(r.data || "{}"),
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

  // App duration calculation per session
  public perAppDurationsForSession(sessionId: string): Map<string, number> {
    const events = this.listEvents(sessionId, 500);
    const session = this.getSession(sessionId);
    const totalMs = session?.durationMs ?? 0;
    const map = new Map<string, number>();

    if (events.length === 0) {
      if (session?.appNames?.length) {
        map.set(session.appNames[0], totalMs);
      }
      return map;
    }

    let currentApp = events[0].appName || "Unknown";
    let lastTs = events[0].timestamp;

    for (let i = 1; i < events.length; i++) {
      const ev = events[i];
      const dur = Math.max(0, ev.timestamp - lastTs);
      map.set(currentApp, (map.get(currentApp) ?? 0) + dur);
      if (ev.appName) currentApp = ev.appName;
      lastTs = ev.timestamp;
    }

    if (session?.endedAt) {
      const rem = Math.max(0, session.endedAt - lastTs);
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
      stats: JSON.parse(row.stats || "{}"),
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
      appNames: JSON.parse(r.app_names || "[]"),
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
      entities: JSON.parse(r.entities || "{}"),
      topics: JSON.parse(r.topics || "[]"),
      project: r.project,
      highlights: JSON.parse(r.highlights || "[]"),
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }
}
