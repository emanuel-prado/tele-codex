import Database from "better-sqlite3";
import type { AdapterKind, LogEntry, PendingAction, SessionRef, SessionStatus } from "../types/events.js";

export interface StoredSession extends SessionRef {
  status: SessionStatus;
  paused: boolean;
  activeTurnId?: string;
  createdAt: number;
  updatedAt: number;
}

type Row = Record<string, unknown>;

export class Store {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  upsertSession(session: SessionRef, status: SessionStatus): void {
    const now = Date.now();
    this.db
      .prepare(
        `insert into sessions (id, adapter, label, cwd, codex_thread_id, tmux_target, status, paused, created_at, updated_at)
         values (@id, @adapter, @label, @cwd, @codexThreadId, @tmuxTarget, @status, 0, @now, @now)
         on conflict(id) do update set
           label=excluded.label,
           cwd=excluded.cwd,
           codex_thread_id=excluded.codex_thread_id,
           tmux_target=excluded.tmux_target,
           status=excluded.status,
           updated_at=excluded.updated_at`
      )
      .run({
        id: session.id,
        adapter: session.adapter,
        label: session.label,
        cwd: session.cwd ?? null,
        codexThreadId: session.codexThreadId ?? null,
        tmuxTarget: session.tmuxTarget ?? null,
        status,
        now
      });
  }

  updateAttachState(
    sessionId: string,
    state: {
      attachStatus?: NonNullable<SessionRef["attachStatus"]>;
      submitStrategy?: string | null;
      lastProbe?: string | null;
      lastProbeAt?: number | null;
    }
  ): void {
    const session = this.getSession(sessionId);
    if (!session) return;
    this.db
      .prepare(
        `update sessions
         set attach_status = ?,
             submit_strategy = ?,
             last_probe = ?,
             last_probe_at = ?,
             updated_at = ?
         where id = ?`
      )
      .run(
        state.attachStatus ?? session.attachStatus ?? "unknown",
        state.submitStrategy === undefined ? (session.submitStrategy ?? null) : state.submitStrategy,
        state.lastProbe === undefined ? (session.lastProbe ?? null) : state.lastProbe,
        state.lastProbeAt === undefined ? (session.lastProbeAt ?? null) : state.lastProbeAt,
        Date.now(),
        sessionId
      );
  }

  setSessionStatus(sessionId: string, status: SessionStatus): void {
    this.db
      .prepare("update sessions set status = ?, updated_at = ? where id = ?")
      .run(status, Date.now(), sessionId);
  }

  setPaused(sessionId: string, paused: boolean): void {
    this.db
      .prepare("update sessions set paused = ?, status = ?, updated_at = ? where id = ?")
      .run(paused ? 1 : 0, paused ? "paused" : "idle", Date.now(), sessionId);
  }

  setActiveTurn(sessionId: string, turnId: string | null): void {
    this.db
      .prepare("update sessions set active_turn_id = ?, updated_at = ? where id = ?")
      .run(turnId, Date.now(), sessionId);
  }

  getSession(sessionId: string): StoredSession | undefined {
    const row = this.db.prepare("select * from sessions where id = ?").get(sessionId) as Row | undefined;
    return row ? mapSession(row) : undefined;
  }

  listSessions(): StoredSession[] {
    const rows = this.db.prepare("select * from sessions order by updated_at desc").all() as Row[];
    return rows.map(mapSession);
  }

  putPendingAction(action: PendingAction): void {
    this.db
      .prepare(
        `insert into pending_actions
          (id, kind, session_id, request_id, thread_id, turn_id, item_id, title, body, payload_json, nonce, status, expires_at, created_at)
         values
          (@id, @kind, @sessionId, @requestId, @threadId, @turnId, @itemId, @title, @body, @payloadJson, @nonce, 'pending', @expiresAt, @createdAt)
         on conflict(id) do update set
          body=excluded.body,
          payload_json=excluded.payload_json,
          nonce=excluded.nonce,
          status='pending',
          expires_at=excluded.expires_at`
      )
      .run({
        id: action.id,
        kind: action.kind,
        sessionId: action.sessionId,
        requestId: action.requestId == null ? null : String(action.requestId),
        threadId: action.threadId ?? null,
        turnId: action.turnId ?? null,
        itemId: action.itemId ?? null,
        title: action.title,
        body: action.body,
        payloadJson: JSON.stringify(action.payload),
        nonce: action.nonce,
        expiresAt: action.expiresAt,
        createdAt: Date.now()
      });
  }

  getPendingAction(actionId: string): PendingAction | undefined {
    const row = this.db.prepare("select * from pending_actions where id = ?").get(actionId) as Row | undefined;
    return row ? mapPendingAction(row) : undefined;
  }

  getNewestPendingQuestion(sessionId: string): PendingAction | undefined {
    const row = this.db
      .prepare(
        `select * from pending_actions
         where session_id = ? and kind = 'question' and status = 'pending' and expires_at > ?
         order by created_at desc
         limit 1`
      )
      .get(sessionId, Date.now()) as Row | undefined;
    return row ? mapPendingAction(row) : undefined;
  }

  resolvePendingAction(actionId: string, status: "resolved" | "expired" | "cancelled"): void {
    this.db
      .prepare("update pending_actions set status = ?, resolved_at = ? where id = ?")
      .run(status, Date.now(), actionId);
  }

  setTelegramMessage(actionId: string, chatId: number, messageId: number): void {
    this.db
      .prepare("update pending_actions set telegram_chat_id = ?, telegram_message_id = ? where id = ?")
      .run(chatId, messageId, actionId);
  }

  appendLog(entry: Omit<LogEntry, "id" | "timestamp"> & { timestamp?: number }): void {
    this.db
      .prepare(
        `insert into event_log (session_id, timestamp, type, severity, text, payload_json)
         values (?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.sessionId,
        entry.timestamp ?? Date.now(),
        entry.type,
        entry.severity,
        entry.text,
        entry.payload === undefined ? null : JSON.stringify(entry.payload)
      );
  }

  recentLogs(sessionId: string, limit: number): LogEntry[] {
    const rows = this.db
      .prepare("select * from event_log where session_id = ? order by id desc limit ?")
      .all(sessionId, limit) as Row[];
    return rows.reverse().map(mapLog);
  }

  appendTranscript(sessionId: string, text: string, metadata?: unknown): void {
    this.db
      .prepare(
        `insert into transcript_chunks (session_id, timestamp, text, metadata_json)
         values (?, ?, ?, ?)`
      )
      .run(sessionId, Date.now(), text, metadata === undefined ? null : JSON.stringify(metadata));
  }

  getTranscript(sessionId: string): string {
    const rows = this.db
      .prepare("select timestamp, text from transcript_chunks where session_id = ? order by id asc")
      .all(sessionId) as Array<{ timestamp: number; text: string }>;
    return rows
      .map((row) => {
        const ts = new Date(Number(row.timestamp)).toISOString();
        return `[${ts}]\n${String(row.text).trim()}`;
      })
      .join("\n\n");
  }

  grantSession(actionId: string, sessionId: string, payload: unknown, expiresAt: number): void {
    this.db
      .prepare(
        `insert into session_grants (action_id, session_id, payload_json, expires_at, created_at, revoked)
         values (?, ?, ?, ?, ?, 0)`
      )
      .run(actionId, sessionId, JSON.stringify(payload), expiresAt, Date.now());
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists sessions (
        id text primary key,
        adapter text not null,
        label text not null,
        cwd text,
        codex_thread_id text,
        tmux_target text,
        status text not null,
        paused integer not null default 0,
        active_turn_id text,
        attach_status text,
        submit_strategy text,
        last_probe text,
        last_probe_at integer,
        created_at integer not null,
        updated_at integer not null
      );

      create table if not exists pending_actions (
        id text primary key,
        kind text not null,
        session_id text not null,
        request_id text,
        thread_id text,
        turn_id text,
        item_id text,
        title text not null,
        body text not null,
        payload_json text not null,
        nonce text not null,
        status text not null,
        expires_at integer not null,
        created_at integer not null,
        resolved_at integer,
        telegram_chat_id integer,
        telegram_message_id integer
      );

      create table if not exists event_log (
        id integer primary key autoincrement,
        session_id text not null,
        timestamp integer not null,
        type text not null,
        severity text not null,
        text text not null,
        payload_json text
      );

      create table if not exists session_grants (
        id integer primary key autoincrement,
        action_id text not null,
        session_id text not null,
        payload_json text not null,
        expires_at integer not null,
        created_at integer not null,
        revoked integer not null default 0
      );

      create table if not exists transcript_chunks (
        id integer primary key autoincrement,
        session_id text not null,
        timestamp integer not null,
        text text not null,
        metadata_json text
      );
    `);
    this.addColumnIfMissing("sessions", "attach_status", "text");
    this.addColumnIfMissing("sessions", "submit_strategy", "text");
    this.addColumnIfMissing("sessions", "last_probe", "text");
    this.addColumnIfMissing("sessions", "last_probe_at", "integer");
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    const columns = this.db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`alter table ${table} add column ${column} ${type}`);
    }
  }
}

function mapSession(row: Row): StoredSession {
  const session: StoredSession = {
    id: String(row.id),
    adapter: row.adapter as AdapterKind,
    label: String(row.label),
    status: row.status as SessionStatus,
    paused: Number(row.paused) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
  if (row.cwd) session.cwd = String(row.cwd);
  if (row.codex_thread_id) session.codexThreadId = String(row.codex_thread_id);
  if (row.tmux_target) session.tmuxTarget = String(row.tmux_target);
  if (row.active_turn_id) session.activeTurnId = String(row.active_turn_id);
  if (row.attach_status) session.attachStatus = row.attach_status as NonNullable<SessionRef["attachStatus"]>;
  if (row.submit_strategy) session.submitStrategy = String(row.submit_strategy);
  if (row.last_probe) session.lastProbe = String(row.last_probe);
  if (row.last_probe_at) session.lastProbeAt = Number(row.last_probe_at);
  return session;
}

function mapPendingAction(row: Row): PendingAction {
  const action: PendingAction = {
    id: String(row.id),
    kind: row.kind as PendingAction["kind"],
    sessionId: String(row.session_id),
    title: String(row.title),
    body: String(row.body),
    payload: JSON.parse(String(row.payload_json)),
    nonce: String(row.nonce),
    expiresAt: Number(row.expires_at)
  };
  if (row.request_id) action.requestId = String(row.request_id);
  if (row.thread_id) action.threadId = String(row.thread_id);
  if (row.turn_id) action.turnId = String(row.turn_id);
  if (row.item_id) action.itemId = String(row.item_id);
  return action;
}

function mapLog(row: Row): LogEntry {
  const payloadJson = row.payload_json ? String(row.payload_json) : undefined;
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    timestamp: Number(row.timestamp),
    type: String(row.type),
    severity: row.severity as LogEntry["severity"],
    text: String(row.text),
    payload: payloadJson ? JSON.parse(payloadJson) : undefined
  };
}
