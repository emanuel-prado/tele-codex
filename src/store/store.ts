import Database from "better-sqlite3";
import type { RateLimitSummary, SessionProgress, SessionTokenUsage, ThreadGoalSummary } from "../types/control.js";
import type { AdapterKind, LogEntry, PendingAction, SessionRef, SessionStatus } from "../types/events.js";

export type PendingActionStatus = "pending" | "submitting" | "resolved" | "expired" | "cancelled" | "orphaned";

export interface StoredPendingAction extends PendingAction {
  status: PendingActionStatus;
  createdAt: number;
  resolvedAt?: number;
}

export interface CallbackToken {
  token: string;
  actionId: string;
  chatId: number;
  operation: string;
  payload: unknown;
  expiresAt: number;
}

export interface InteractionDraft {
  actionId: string;
  chatId: number;
  userId: number;
  questionIndex: number;
  answers: Record<string, { answers: string[] }>;
  awaitingText: boolean;
}

export interface OutboxMessage {
  id: number;
  eventKey: string;
  chatId: number;
  actionId?: string;
  payload: {
    text: string;
    parseMode?: "MarkdownV2";
    keyboard?: unknown[][];
  };
  attempts: number;
}

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
          (id, kind, session_id, request_id, request_id_type, thread_id, turn_id, item_id, title, body, payload_json, nonce, status, expires_at, created_at)
         values
          (@id, @kind, @sessionId, @requestId, @requestIdType, @threadId, @turnId, @itemId, @title, @body, @payloadJson, @nonce, 'pending', @expiresAt, @createdAt)
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
        requestIdType: action.requestId == null ? null : typeof action.requestId,
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

  getPendingAction(actionId: string): StoredPendingAction | undefined {
    const row = this.db.prepare("select * from pending_actions where id = ?").get(actionId) as Row | undefined;
    return row ? mapPendingAction(row) : undefined;
  }

  listPendingActions(sessionId?: string): StoredPendingAction[] {
    const rows = sessionId
      ? (this.db
          .prepare("select * from pending_actions where status = 'pending' and expires_at > ? and session_id = ? order by created_at")
          .all(Date.now(), sessionId) as Row[])
      : (this.db
          .prepare("select * from pending_actions where status = 'pending' and expires_at > ? order by created_at")
          .all(Date.now()) as Row[]);
    return rows.map(mapPendingAction);
  }

  claimPendingAction(actionId: string): StoredPendingAction | undefined {
    const result = this.db
      .prepare("update pending_actions set status = 'submitting' where id = ? and status = 'pending' and expires_at > ?")
      .run(actionId, Date.now());
    return result.changes === 1 ? this.getPendingAction(actionId) : undefined;
  }

  listExpiredActions(): StoredPendingAction[] {
    const rows = this.db
      .prepare("select * from pending_actions where status = 'pending' and expires_at <= ? order by created_at")
      .all(Date.now()) as Row[];
    return rows.map(mapPendingAction);
  }

  claimExpiredAction(actionId: string): StoredPendingAction | undefined {
    const result = this.db
      .prepare("update pending_actions set status = 'submitting' where id = ? and status = 'pending' and expires_at <= ?")
      .run(actionId, Date.now());
    return result.changes === 1 ? this.getPendingAction(actionId) : undefined;
  }

  releasePendingAction(actionId: string): void {
    this.db.prepare("update pending_actions set status = 'pending' where id = ? and status = 'submitting'").run(actionId);
  }

  orphanOpenActions(): number {
    const result = this.db
      .prepare("update pending_actions set status = 'orphaned', resolved_at = ? where status in ('pending', 'submitting')")
      .run(Date.now());
    return result.changes;
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

  countPendingActions(sessionId: string): number {
    const row = this.db
      .prepare("select count(*) as count from pending_actions where session_id = ? and status = 'pending' and expires_at > ?")
      .get(sessionId, Date.now()) as { count: number };
    return Number(row.count);
  }

  setTokenUsage(sessionId: string, usage: Omit<SessionTokenUsage, "updatedAt"> & { updatedAt?: number }): void {
    this.db
      .prepare(
        `insert into token_usage
          (session_id, updated_at, total_tokens, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens,
           last_total_tokens, last_input_tokens, last_cached_input_tokens, last_output_tokens, last_reasoning_output_tokens,
           model_context_window)
         values
          (@sessionId, @updatedAt, @totalTokens, @inputTokens, @cachedInputTokens, @outputTokens, @reasoningOutputTokens,
           @lastTotalTokens, @lastInputTokens, @lastCachedInputTokens, @lastOutputTokens, @lastReasoningOutputTokens,
           @modelContextWindow)
         on conflict(session_id) do update set
           updated_at=excluded.updated_at,
           total_tokens=excluded.total_tokens,
           input_tokens=excluded.input_tokens,
           cached_input_tokens=excluded.cached_input_tokens,
           output_tokens=excluded.output_tokens,
           reasoning_output_tokens=excluded.reasoning_output_tokens,
           last_total_tokens=excluded.last_total_tokens,
           last_input_tokens=excluded.last_input_tokens,
           last_cached_input_tokens=excluded.last_cached_input_tokens,
           last_output_tokens=excluded.last_output_tokens,
           last_reasoning_output_tokens=excluded.last_reasoning_output_tokens,
           model_context_window=excluded.model_context_window`
      )
      .run({
        sessionId,
        updatedAt: usage.updatedAt ?? Date.now(),
        totalTokens: usage.total.totalTokens,
        inputTokens: usage.total.inputTokens,
        cachedInputTokens: usage.total.cachedInputTokens,
        outputTokens: usage.total.outputTokens,
        reasoningOutputTokens: usage.total.reasoningOutputTokens,
        lastTotalTokens: usage.last.totalTokens,
        lastInputTokens: usage.last.inputTokens,
        lastCachedInputTokens: usage.last.cachedInputTokens,
        lastOutputTokens: usage.last.outputTokens,
        lastReasoningOutputTokens: usage.last.reasoningOutputTokens,
        modelContextWindow: usage.modelContextWindow ?? null
      });
  }

  getTokenUsage(sessionId: string): SessionTokenUsage | undefined {
    const row = this.db.prepare("select * from token_usage where session_id = ?").get(sessionId) as Row | undefined;
    return row ? mapTokenUsage(row) : undefined;
  }

  setProgress(sessionId: string, progress: SessionProgress): void {
    this.upsertRuntimeState(sessionId, "progress_json", JSON.stringify(progress));
  }

  getProgress(sessionId: string): SessionProgress | undefined {
    const row = this.db.prepare("select progress_json from session_runtime where session_id = ?").get(sessionId) as Row | undefined;
    return row?.progress_json ? (JSON.parse(String(row.progress_json)) as SessionProgress) : undefined;
  }

  setDiff(sessionId: string, diff: string): void {
    this.upsertRuntimeState(sessionId, "diff_text", diff);
  }

  getDiff(sessionId: string): string | undefined {
    const row = this.db.prepare("select diff_text from session_runtime where session_id = ?").get(sessionId) as Row | undefined;
    return row?.diff_text ? String(row.diff_text) : undefined;
  }

  setGoal(sessionId: string, goal: ThreadGoalSummary | undefined): void {
    this.upsertRuntimeState(sessionId, "goal_json", goal ? JSON.stringify(goal) : null);
  }

  getGoal(sessionId: string): ThreadGoalSummary | undefined {
    const row = this.db.prepare("select goal_json from session_runtime where session_id = ?").get(sessionId) as Row | undefined;
    return row?.goal_json ? (JSON.parse(String(row.goal_json)) as ThreadGoalSummary) : undefined;
  }

  setRateLimits(limits: RateLimitSummary): void {
    this.db.prepare(
      `insert into global_runtime (key, value_json, updated_at) values ('rate_limits', ?, ?)
       on conflict(key) do update set value_json=excluded.value_json, updated_at=excluded.updated_at`
    ).run(JSON.stringify(limits), Date.now());
  }

  getRateLimits(): RateLimitSummary | undefined {
    const row = this.db.prepare("select value_json from global_runtime where key = 'rate_limits'").get() as Row | undefined;
    return row ? (JSON.parse(String(row.value_json)) as RateLimitSummary) : undefined;
  }

  setRuntimeValue(key: string, value: unknown): void {
    this.db.prepare(
      `insert into global_runtime (key, value_json, updated_at) values (?, ?, ?)
       on conflict(key) do update set value_json=excluded.value_json, updated_at=excluded.updated_at`
    ).run(key, JSON.stringify(value), Date.now());
  }

  getRuntimeValue<T>(key: string): T | undefined {
    const row = this.db.prepare("select value_json from global_runtime where key = ?").get(key) as Row | undefined;
    return row ? (JSON.parse(String(row.value_json)) as T) : undefined;
  }

  resolvePendingAction(actionId: string, status: "resolved" | "expired" | "cancelled" | "orphaned"): void {
    this.db
      .prepare("update pending_actions set status = ?, resolved_at = ? where id = ?")
      .run(status, Date.now(), actionId);
  }

  resolvePendingActionByRequestId(requestId: string | number, status: "resolved" | "expired" | "cancelled" = "resolved"): string | undefined {
    const row = this.db
      .prepare("select id from pending_actions where request_id = ? and status in ('pending', 'submitting', 'expired') order by created_at desc limit 1")
      .get(String(requestId)) as { id: string } | undefined;
    if (!row) return undefined;
    this.resolvePendingAction(row.id, status);
    this.deleteInteractionDraft(row.id);
    return row.id;
  }

  putCallbackToken(token: CallbackToken): void {
    this.db.prepare(
      `insert into callback_tokens (token, action_id, chat_id, operation, payload_json, expires_at, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`
    ).run(token.token, token.actionId, token.chatId, token.operation, JSON.stringify(token.payload), token.expiresAt, Date.now());
  }

  consumeCallbackToken(token: string, chatId: number): CallbackToken | undefined {
    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare("select * from callback_tokens where token = ? and chat_id = ? and consumed_at is null and expires_at > ?")
        .get(token, chatId, Date.now()) as Row | undefined;
      if (!row) return undefined;
      this.db.prepare("update callback_tokens set consumed_at = ? where token = ?").run(Date.now(), token);
      return mapCallbackToken(row);
    });
    return transaction();
  }

  putInteractionDraft(draft: InteractionDraft): void {
    this.db.prepare(
      `insert into interaction_drafts (action_id, chat_id, user_id, question_index, answers_json, awaiting_text, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict(action_id, chat_id, user_id) do update set
         question_index=excluded.question_index,
         answers_json=excluded.answers_json,
         awaiting_text=excluded.awaiting_text,
         updated_at=excluded.updated_at`
    ).run(
      draft.actionId,
      draft.chatId,
      draft.userId,
      draft.questionIndex,
      JSON.stringify(draft.answers),
      draft.awaitingText ? 1 : 0,
      Date.now()
    );
  }

  getInteractionDraft(actionId: string, chatId: number, userId: number): InteractionDraft | undefined {
    const row = this.db
      .prepare("select * from interaction_drafts where action_id = ? and chat_id = ? and user_id = ?")
      .get(actionId, chatId, userId) as Row | undefined;
    return row ? mapInteractionDraft(row) : undefined;
  }

  getAwaitingInteractionDraft(chatId: number, userId: number): InteractionDraft | undefined {
    const row = this.db
      .prepare(
        `select d.* from interaction_drafts d
         join pending_actions a on a.id = d.action_id
         where d.chat_id = ? and d.user_id = ? and d.awaiting_text = 1 and a.status = 'pending' and a.expires_at > ?
         order by d.updated_at desc limit 1`
      )
      .get(chatId, userId, Date.now()) as Row | undefined;
    return row ? mapInteractionDraft(row) : undefined;
  }

  clearInteractionDraftsForUser(chatId: number, userId: number): void {
    this.db.prepare("delete from interaction_drafts where chat_id = ? and user_id = ?").run(chatId, userId);
  }

  deleteInteractionDraft(actionId: string): void {
    this.db.prepare("delete from interaction_drafts where action_id = ?").run(actionId);
  }

  enqueueOutbox(
    eventKey: string,
    chatId: number,
    payload: OutboxMessage["payload"],
    actionId?: string
  ): void {
    this.db.prepare(
      `insert into notification_outbox
        (event_key, chat_id, action_id, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
       values (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
       on conflict(event_key, chat_id) do nothing`
    ).run(eventKey, chatId, actionId ?? null, JSON.stringify(payload), Date.now(), Date.now(), Date.now());
  }

  dueOutbox(limit = 20): OutboxMessage[] {
    const rows = this.db
      .prepare(
        `select * from notification_outbox
         where status = 'pending' and next_attempt_at <= ?
         order by id limit ?`
      )
      .all(Date.now(), limit) as Row[];
    return rows.map(mapOutboxMessage);
  }

  markOutboxSent(id: number): void {
    this.db.prepare("update notification_outbox set status = 'sent', updated_at = ? where id = ?").run(Date.now(), id);
  }

  retryOutbox(id: number, attempts: number, error: string): void {
    const status = attempts >= 20 ? "failed" : "pending";
    const delay = Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8));
    this.db.prepare(
      "update notification_outbox set status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? where id = ?"
    ).run(status, attempts, Date.now() + delay, error.slice(0, 1000), Date.now(), id);
  }

  outboxCounts(): { pending: number; failed: number } {
    const rows = this.db
      .prepare("select status, count(*) as count from notification_outbox where status in ('pending', 'failed') group by status")
      .all() as Array<{ status: string; count: number }>;
    return {
      pending: Number(rows.find((row) => row.status === "pending")?.count ?? 0),
      failed: Number(rows.find((row) => row.status === "failed")?.count ?? 0)
    };
  }

  retryFailedOutbox(): number {
    const result = this.db
      .prepare("update notification_outbox set status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ? where status = 'failed'")
      .run(Date.now(), Date.now());
    return result.changes;
  }

  setTelegramMessage(actionId: string, chatId: number, messageId: number): void {
    this.db
      .prepare("update pending_actions set telegram_chat_id = ?, telegram_message_id = ? where id = ?")
      .run(chatId, messageId, actionId);
    this.db.prepare(
      `insert into action_messages (action_id, chat_id, message_id) values (?, ?, ?)
       on conflict(action_id, chat_id) do update set message_id=excluded.message_id`
    ).run(actionId, chatId, messageId);
  }

  listTelegramMessages(actionId: string): Array<{ chatId: number; messageId: number }> {
    return (this.db.prepare("select chat_id, message_id from action_messages where action_id = ?").all(actionId) as Row[])
      .map((row) => ({ chatId: Number(row.chat_id), messageId: Number(row.message_id) }));
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
        request_id_type text,
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

      create table if not exists token_usage (
        session_id text primary key,
        updated_at integer not null,
        total_tokens integer not null,
        input_tokens integer not null,
        cached_input_tokens integer not null,
        output_tokens integer not null,
        reasoning_output_tokens integer not null,
        last_total_tokens integer not null,
        last_input_tokens integer not null,
        last_cached_input_tokens integer not null,
        last_output_tokens integer not null,
        last_reasoning_output_tokens integer not null,
        model_context_window integer
      );

      create table if not exists callback_tokens (
        token text primary key,
        action_id text not null,
        chat_id integer not null,
        operation text not null,
        payload_json text not null,
        expires_at integer not null,
        created_at integer not null,
        consumed_at integer
      );

      create table if not exists interaction_drafts (
        action_id text not null,
        chat_id integer not null,
        user_id integer not null,
        question_index integer not null,
        answers_json text not null,
        awaiting_text integer not null,
        updated_at integer not null,
        primary key (action_id, chat_id, user_id)
      );

      create table if not exists notification_outbox (
        id integer primary key autoincrement,
        event_key text not null,
        chat_id integer not null,
        action_id text,
        payload_json text not null,
        status text not null,
        attempts integer not null,
        next_attempt_at integer not null,
        last_error text,
        created_at integer not null,
        updated_at integer not null,
        unique(event_key, chat_id)
      );

      create table if not exists session_runtime (
        session_id text primary key,
        progress_json text,
        diff_text text,
        goal_json text,
        updated_at integer not null
      );

      create table if not exists global_runtime (
        key text primary key,
        value_json text not null,
        updated_at integer not null
      );

      create table if not exists action_messages (
        action_id text not null,
        chat_id integer not null,
        message_id integer not null,
        primary key (action_id, chat_id)
      );
    `);
    this.addColumnIfMissing("sessions", "attach_status", "text");
    this.addColumnIfMissing("sessions", "submit_strategy", "text");
    this.addColumnIfMissing("sessions", "last_probe", "text");
    this.addColumnIfMissing("sessions", "last_probe_at", "integer");
    this.addColumnIfMissing("pending_actions", "request_id_type", "text");
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    const columns = this.db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`alter table ${table} add column ${column} ${type}`);
    }
  }

  private upsertRuntimeState(sessionId: string, column: "progress_json" | "diff_text" | "goal_json", value: string | null): void {
    this.db.prepare(
      `insert into session_runtime (session_id, ${column}, updated_at) values (?, ?, ?)
       on conflict(session_id) do update set ${column}=excluded.${column}, updated_at=excluded.updated_at`
    ).run(sessionId, value, Date.now());
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

function mapPendingAction(row: Row): StoredPendingAction {
  const action: StoredPendingAction = {
    id: String(row.id),
    kind: row.kind as PendingAction["kind"],
    sessionId: String(row.session_id),
    title: String(row.title),
    body: String(row.body),
    payload: JSON.parse(String(row.payload_json)),
    nonce: String(row.nonce),
    expiresAt: Number(row.expires_at),
    status: String(row.status) as PendingActionStatus,
    createdAt: Number(row.created_at)
  };
  if (row.request_id) action.requestId = row.request_id_type === "number" ? Number(row.request_id) : String(row.request_id);
  if (row.thread_id) action.threadId = String(row.thread_id);
  if (row.turn_id) action.turnId = String(row.turn_id);
  if (row.item_id) action.itemId = String(row.item_id);
  if (row.resolved_at) action.resolvedAt = Number(row.resolved_at);
  return action;
}

function mapCallbackToken(row: Row): CallbackToken {
  return {
    token: String(row.token),
    actionId: String(row.action_id),
    chatId: Number(row.chat_id),
    operation: String(row.operation),
    payload: JSON.parse(String(row.payload_json)),
    expiresAt: Number(row.expires_at)
  };
}

function mapInteractionDraft(row: Row): InteractionDraft {
  return {
    actionId: String(row.action_id),
    chatId: Number(row.chat_id),
    userId: Number(row.user_id),
    questionIndex: Number(row.question_index),
    answers: JSON.parse(String(row.answers_json)) as Record<string, { answers: string[] }>,
    awaitingText: Number(row.awaiting_text) === 1
  };
}

function mapOutboxMessage(row: Row): OutboxMessage {
  const message: OutboxMessage = {
    id: Number(row.id),
    eventKey: String(row.event_key),
    chatId: Number(row.chat_id),
    payload: JSON.parse(String(row.payload_json)) as OutboxMessage["payload"],
    attempts: Number(row.attempts)
  };
  if (row.action_id) message.actionId = String(row.action_id);
  return message;
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

function mapTokenUsage(row: Row): SessionTokenUsage {
  const usage: SessionTokenUsage = {
    total: {
      totalTokens: Number(row.total_tokens),
      inputTokens: Number(row.input_tokens),
      cachedInputTokens: Number(row.cached_input_tokens),
      outputTokens: Number(row.output_tokens),
      reasoningOutputTokens: Number(row.reasoning_output_tokens)
    },
    last: {
      totalTokens: Number(row.last_total_tokens),
      inputTokens: Number(row.last_input_tokens),
      cachedInputTokens: Number(row.last_cached_input_tokens),
      outputTokens: Number(row.last_output_tokens),
      reasoningOutputTokens: Number(row.last_reasoning_output_tokens)
    },
    updatedAt: Number(row.updated_at)
  };
  if (row.model_context_window) usage.modelContextWindow = Number(row.model_context_window);
  return usage;
}
