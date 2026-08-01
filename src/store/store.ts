import Database from "better-sqlite3";
import type { RateLimitSummary, SessionProgress, SessionTokenUsage, ThreadGoalSummary } from "../types/control.js";
import type { LogEntry, PendingAction, SessionRef, SessionStatus } from "../types/events.js";
import type { LegacyTmuxAttachment, LegacyTmuxInputStatus, LegacyTmuxStatus } from "../types/legacy-tmux.js";

export type PendingActionStatus = "pending" | "submitting" | "resolved" | "expired" | "cancelled" | "orphaned" | "failed";

export interface StoredPendingAction extends PendingAction {
  status: PendingActionStatus;
  createdAt: number;
  resolvedAt?: number;
  failureReason?: string;
}

export interface CallbackToken {
  token: string;
  actionId: string;
  chatId: number;
  userId?: number;
  operation: string;
  payload: unknown;
  expiresAt: number;
}

export interface ClaimedCallbackToken extends CallbackToken {
  claimId: string;
}

export interface RoutingCompose {
  chatId: number;
  userId: number;
  sessionId: string;
  expectedVersion: number;
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

const CODEX_THREAD_SELECT = `
  select
    t.id,
    t.codex_thread_id,
    t.label,
    t.cwd,
    t.lifecycle_status,
    t.paused,
    t.created_at,
    t.updated_at,
    a.status as attachment_status,
    a.connection_generation,
    a.updated_at as attachment_updated_at,
    v.codex_turn_id,
    v.updated_at as turn_updated_at
  from codex_threads t
  left join appserver_attachments a on a.thread_id = t.id
  left join active_turns v on v.thread_id = t.id`;

export class Store {
  private readonly db: Database.Database;
  private closed = false;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    this.releaseStaleCallbackClaims(Date.now() + 1);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  upsertSession(session: SessionRef, status: SessionStatus): StoredSession {
    if (!session.codexThreadId) throw new Error("App-server threads require a Codex thread id.");
    return this.upsertCodexThread(session, status);
  }

  setSessionStatus(sessionId: string, status: SessionStatus): void {
    if (this.getCodexThreadRow(sessionId)) {
      if (status === "archived") {
        this.markThreadArchived(sessionId);
      } else if (status === "detached" || status === "stopped") {
        this.markThreadDetached(sessionId);
      } else {
        this.upsertAttachment(sessionId, status);
      }
      return;
    }
  }

  clearSessionAttachments(connectionGeneration?: number): string[] {
    const normalized = connectionGeneration === undefined
      ? this.db.prepare("select thread_id as id from appserver_attachments where connection_generation is not null").all() as Array<{ id: string }>
      : this.db.prepare("select thread_id as id from appserver_attachments where connection_generation = ?").all(connectionGeneration) as Array<{ id: string }>;
    const transaction = this.db.transaction(() => {
      for (const row of normalized) this.markThreadDetached(row.id);
    });
    transaction();
    return normalized.map((row) => row.id);
  }

  setPaused(sessionId: string, paused: boolean): void {
    if (this.getCodexThreadRow(sessionId)) {
      this.db.prepare("update codex_threads set paused = ?, updated_at = ? where id = ?").run(paused ? 1 : 0, Date.now(), sessionId);
      return;
    }
  }

  setActiveTurn(sessionId: string, turnId: string | null): void {
    if (this.getCodexThreadRow(sessionId)) {
      if (turnId) {
        this.db.prepare(
          `insert into active_turns (thread_id, codex_turn_id, status, started_at, updated_at)
           values (?, ?, 'active', ?, ?)
           on conflict(thread_id) do update set codex_turn_id=excluded.codex_turn_id, status='active', updated_at=excluded.updated_at`
        ).run(sessionId, turnId, Date.now(), Date.now());
        this.upsertAttachment(sessionId, "active");
      } else {
        this.db.prepare("delete from active_turns where thread_id = ?").run(sessionId);
      }
      return;
    }
  }

  getSession(sessionId: string): StoredSession | undefined {
    const thread = this.getCodexThreadRow(sessionId);
    if (thread) return mapCodexThread(thread);
    return undefined;
  }

  getSessionByCodexThreadId(codexThreadId: string): StoredSession | undefined {
    const row = this.db.prepare(`${CODEX_THREAD_SELECT} where t.codex_thread_id = ?`).get(codexThreadId) as Row | undefined;
    return row ? mapCodexThread(row) : undefined;
  }

  listSessions(includeAll = false): StoredSession[] {
    const threadRows = this.db.prepare(
      `${CODEX_THREAD_SELECT}${includeAll ? "" : " where t.lifecycle_status = 'available'"}`
    ).all() as Row[];
    return threadRows.map(mapCodexThread).sort((left, right) => right.updatedAt - left.updatedAt);
  }

  upsertLegacyTmuxAttachment(input: {
    id: string;
    target: string;
    label: string;
    cwd?: string;
    chatId: number;
    status?: LegacyTmuxStatus;
    inputStatus?: LegacyTmuxInputStatus;
    submitStrategy: string;
  }): LegacyTmuxAttachment {
    const now = Date.now();
    this.db.prepare(
      `insert into legacy_tmux_attachments
        (id, target, label, cwd, chat_id, status, input_status, submit_strategy, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         target=excluded.target, label=excluded.label, cwd=excluded.cwd, chat_id=excluded.chat_id,
         status=excluded.status, input_status=excluded.input_status,
         submit_strategy=excluded.submit_strategy, updated_at=excluded.updated_at`
    ).run(
      input.id,
      input.target,
      input.label,
      input.cwd ?? null,
      input.chatId,
      input.status ?? "attached",
      input.inputStatus ?? "unknown",
      input.submitStrategy,
      now,
      now
    );
    return this.getLegacyTmuxAttachment(input.id)!;
  }

  getLegacyTmuxAttachment(id: string): LegacyTmuxAttachment | undefined {
    const row = this.db.prepare("select * from legacy_tmux_attachments where id = ?").get(id) as Row | undefined;
    return row ? mapLegacyTmuxAttachment(row) : undefined;
  }

  listLegacyTmuxAttachments(chatId?: number): LegacyTmuxAttachment[] {
    const rows = chatId === undefined
      ? this.db.prepare("select * from legacy_tmux_attachments order by updated_at desc").all() as Row[]
      : this.db.prepare("select * from legacy_tmux_attachments where chat_id = ? order by updated_at desc").all(chatId) as Row[];
    return rows.map(mapLegacyTmuxAttachment);
  }

  updateLegacyTmuxAttachment(
    id: string,
    state: Partial<Pick<LegacyTmuxAttachment, "status" | "inputStatus" | "submitStrategy" | "lastProbe" | "lastProbeAt">>
  ): void {
    const attachment = this.getLegacyTmuxAttachment(id);
    if (!attachment) return;
    this.db.prepare(
      `update legacy_tmux_attachments set
        status = ?, input_status = ?, submit_strategy = ?, last_probe = ?, last_probe_at = ?, updated_at = ?
       where id = ?`
    ).run(
      state.status ?? attachment.status,
      state.inputStatus ?? attachment.inputStatus,
      state.submitStrategy ?? attachment.submitStrategy,
      state.lastProbe === undefined ? attachment.lastProbe ?? null : state.lastProbe,
      state.lastProbeAt === undefined ? attachment.lastProbeAt ?? null : state.lastProbeAt,
      Date.now(),
      id
    );
  }

  markThreadDetached(sessionId: string): void {
    const now = Date.now();
    this.db.prepare("delete from active_turns where thread_id = ?").run(sessionId);
    this.db.prepare(
      `insert into appserver_attachments (thread_id, status, connection_generation, attached_at, updated_at)
       values (?, 'detached', null, ?, ?)
       on conflict(thread_id) do update set status='detached', connection_generation=null, updated_at=excluded.updated_at`
    ).run(sessionId, now, now);
    this.db.prepare("update codex_threads set updated_at = ? where id = ?").run(now, sessionId);
  }

  markThreadArchived(sessionId: string): void {
    this.markThreadDetached(sessionId);
    this.db.prepare("update codex_threads set lifecycle_status = 'archived', updated_at = ? where id = ?").run(Date.now(), sessionId);
  }

  forgetThread(sessionId: string): boolean {
    const normalized = Boolean(this.getCodexThreadRow(sessionId));
    if (!normalized) return false;
    const transaction = this.db.transaction(() => {
      const actionIds = (this.db.prepare("select id from pending_actions where session_id = ?").all(sessionId) as Array<{ id: string }>).map((row) => row.id);
      for (const actionId of actionIds) {
        this.db.prepare("delete from callback_tokens where action_id = ?").run(actionId);
        this.db.prepare("delete from interaction_drafts where action_id = ?").run(actionId);
        this.db.prepare("delete from action_messages where action_id = ?").run(actionId);
        this.db.prepare("delete from notification_outbox where action_id = ?").run(actionId);
      }
      this.db.prepare("delete from pending_actions where session_id = ?").run(sessionId);
      for (const table of ["event_log", "transcript_chunks", "session_grants", "token_usage", "session_runtime"]) {
        this.db.prepare(`delete from ${table} where session_id = ?`).run(sessionId);
      }
      for (const table of ["routing_composes", "sticky_routes", "session_chats", "telegram_thread_messages"]) {
        this.db.prepare(`delete from ${table} where session_id = ?`).run(sessionId);
      }
      this.db.prepare("delete from active_turns where thread_id = ?").run(sessionId);
      this.db.prepare("delete from appserver_attachments where thread_id = ?").run(sessionId);
      this.db.prepare("delete from codex_threads where id = ?").run(sessionId);
      if (this.getRuntimeValue<string>("last_active_session_id") === sessionId) {
        this.db.prepare("delete from global_runtime where key = 'last_active_session_id'").run();
      }
    });
    transaction();
    return true;
  }

  putPendingAction(action: PendingAction): void {
    this.db
      .prepare(
        `insert into pending_actions
          (id, kind, session_id, request_id, request_id_type, connection_generation, thread_id, turn_id, item_id, title, body, payload_json, nonce, status, expires_at, created_at, failure_reason)
         values
          (@id, @kind, @sessionId, @requestId, @requestIdType, @connectionGeneration, @threadId, @turnId, @itemId, @title, @body, @payloadJson, @nonce, 'pending', @expiresAt, @createdAt, null)
         on conflict(id) do update set
          body=excluded.body,
          payload_json=excluded.payload_json,
          nonce=excluded.nonce,
          status='pending',
          connection_generation=excluded.connection_generation,
          failure_reason=null,
          resolved_at=null,
          expires_at=excluded.expires_at`
      )
      .run({
        id: action.id,
        kind: action.kind,
        sessionId: action.sessionId,
        requestId: action.requestId == null ? null : String(action.requestId),
        requestIdType: action.requestId == null ? null : typeof action.requestId,
        connectionGeneration: action.connectionGeneration ?? null,
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
          .prepare("select * from pending_actions where status in ('pending', 'failed') and expires_at > ? and session_id = ? order by created_at")
          .all(Date.now(), sessionId) as Row[])
      : (this.db
          .prepare("select * from pending_actions where status in ('pending', 'failed') and expires_at > ? order by created_at")
          .all(Date.now()) as Row[]);
    return rows.map(mapPendingAction);
  }

  claimPendingAction(actionId: string): StoredPendingAction | undefined {
    const result = this.db
      .prepare("update pending_actions set status = 'submitting', failure_reason = null where id = ? and status in ('pending', 'failed') and expires_at > ?")
      .run(actionId, Date.now());
    return result.changes === 1 ? this.getPendingAction(actionId) : undefined;
  }

  listExpiredActions(): StoredPendingAction[] {
    const rows = this.db
      .prepare("select * from pending_actions where status in ('pending', 'failed') and expires_at <= ? order by created_at")
      .all(Date.now()) as Row[];
    return rows.map(mapPendingAction);
  }

  claimExpiredAction(actionId: string): StoredPendingAction | undefined {
    const result = this.db
      .prepare("update pending_actions set status = 'submitting', failure_reason = null where id = ? and status in ('pending', 'failed') and expires_at <= ?")
      .run(actionId, Date.now());
    return result.changes === 1 ? this.getPendingAction(actionId) : undefined;
  }

  listExpiredSubmissions(): StoredPendingAction[] {
    return (this.db
      .prepare("select * from pending_actions where status = 'submitting' and expires_at <= ? order by created_at")
      .all(Date.now()) as Row[]).map(mapPendingAction);
  }

  failPendingAction(actionId: string, reason: string): void {
    this.db
      .prepare("update pending_actions set status = 'failed', failure_reason = ? where id = ? and status = 'submitting'")
      .run(reason, actionId);
  }

  orphanOpenActions(connectionGeneration?: number): number {
    const result = connectionGeneration === undefined
      ? this.db
          .prepare("update pending_actions set status = 'orphaned', resolved_at = ? where status in ('pending', 'submitting', 'failed')")
          .run(Date.now())
      : this.db
          .prepare("update pending_actions set status = 'orphaned', resolved_at = ? where connection_generation = ? and status in ('pending', 'submitting', 'failed')")
          .run(Date.now(), connectionGeneration);
    return result.changes;
  }

  listOpenActions(connectionGeneration?: number): StoredPendingAction[] {
    const rows = connectionGeneration === undefined
      ? this.db
          .prepare("select * from pending_actions where status in ('pending', 'submitting', 'failed') order by created_at")
          .all() as Row[]
      : this.db
          .prepare("select * from pending_actions where connection_generation = ? and status in ('pending', 'submitting', 'failed') order by created_at")
          .all(connectionGeneration) as Row[];
    return rows.map(mapPendingAction);
  }

  getNewestPendingQuestion(sessionId: string): PendingAction | undefined {
    const row = this.db
      .prepare(
        `select * from pending_actions
         where session_id = ? and kind = 'question' and status in ('pending', 'failed') and expires_at > ?
         order by created_at desc
         limit 1`
      )
      .get(sessionId, Date.now()) as Row | undefined;
    return row ? mapPendingAction(row) : undefined;
  }

  countPendingActions(sessionId: string): number {
    const row = this.db
      .prepare("select count(*) as count from pending_actions where session_id = ? and status in ('pending', 'failed') and expires_at > ?")
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

  deleteRuntimeValue(key: string): void {
    this.db.prepare("delete from global_runtime where key = ?").run(key);
  }

  resolvePendingAction(actionId: string, status: "resolved" | "expired" | "cancelled" | "orphaned"): void {
    this.db
      .prepare("update pending_actions set status = ?, resolved_at = ? where id = ?")
      .run(status, Date.now(), actionId);
  }

  resolvePendingActionByRequestId(requestId: string | number, connectionGeneration: number, status: "resolved" | "expired" | "cancelled" = "resolved"): string | undefined {
    const row = this.db
      .prepare("select id from pending_actions where request_id = ? and connection_generation = ? and status in ('pending', 'submitting', 'failed', 'expired') order by created_at desc limit 1")
      .get(String(requestId), connectionGeneration) as { id: string } | undefined;
    if (!row) return undefined;
    this.resolvePendingAction(row.id, status);
    this.deleteInteractionDraft(row.id);
    return row.id;
  }

  putCallbackToken(token: CallbackToken): void {
    this.db.prepare(
      `insert into callback_tokens (token, action_id, chat_id, user_id, operation, payload_json, expires_at, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(token.token, token.actionId, token.chatId, token.userId ?? null, token.operation, JSON.stringify(token.payload), token.expiresAt, Date.now());
  }

  claimCallbackToken(token: string, chatId: number, userId: number | undefined, claimId: string): ClaimedCallbackToken | undefined {
    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare("select * from callback_tokens where token = ? and chat_id = ? and (user_id is null or user_id = ?) and claim_id is null and consumed_at is null and expires_at > ?")
        .get(token, chatId, userId ?? null, Date.now()) as Row | undefined;
      if (!row) return undefined;
      this.db.prepare("update callback_tokens set claim_id = ?, claimed_at = ? where token = ?").run(claimId, Date.now(), token);
      return { ...mapCallbackToken(row), claimId };
    });
    return transaction();
  }

  commitCallbackToken(token: string, claimId: string): boolean {
    return this.db
      .prepare("update callback_tokens set consumed_at = ?, claim_id = null, claimed_at = null where token = ? and claim_id = ? and consumed_at is null")
      .run(Date.now(), token, claimId).changes === 1;
  }

  releaseCallbackToken(token: string, claimId: string): boolean {
    return this.db
      .prepare("update callback_tokens set claim_id = null, claimed_at = null where token = ? and claim_id = ? and consumed_at is null and expires_at > ?")
      .run(token, claimId, Date.now()).changes === 1;
  }

  releaseStaleCallbackClaims(olderThan: number): number {
    return this.db
      .prepare("update callback_tokens set claim_id = null, claimed_at = null where consumed_at is null and claimed_at is not null and claimed_at < ?")
      .run(olderThan).changes;
  }

  putRoutingCompose(compose: RoutingCompose): void {
    this.db.prepare(
      `insert into routing_composes (chat_id, user_id, session_id, expected_version, expires_at, created_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict(chat_id, user_id) do update set
         session_id=excluded.session_id,
         expected_version=excluded.expected_version,
         expires_at=excluded.expires_at,
         created_at=excluded.created_at`
    ).run(compose.chatId, compose.userId, compose.sessionId, compose.expectedVersion, compose.expiresAt, Date.now());
  }

  consumeRoutingCompose(chatId: number, userId: number): RoutingCompose | undefined {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(
        "select * from routing_composes where chat_id = ? and user_id = ? and expires_at > ?"
      ).get(chatId, userId, Date.now()) as Row | undefined;
      this.db.prepare("delete from routing_composes where chat_id = ? and user_id = ?").run(chatId, userId);
      return row ? mapRoutingCompose(row) : undefined;
    });
    return transaction();
  }

  setStickyRoute(chatId: number, userId: number, sessionId: string): void {
    this.db.prepare(
      `insert into sticky_routes (chat_id, user_id, session_id, updated_at) values (?, ?, ?, ?)
       on conflict(chat_id, user_id) do update set session_id=excluded.session_id, updated_at=excluded.updated_at`
    ).run(chatId, userId, sessionId, Date.now());
  }

  getStickyRoute(chatId: number, userId: number): string | undefined {
    const row = this.db.prepare("select session_id from sticky_routes where chat_id = ? and user_id = ?")
      .get(chatId, userId) as { session_id: string } | undefined;
    return row?.session_id;
  }

  clearStickyRoute(chatId: number, userId: number): void {
    this.db.prepare("delete from sticky_routes where chat_id = ? and user_id = ?").run(chatId, userId);
  }

  rememberSessionChat(sessionId: string, chatId: number): void {
    this.db.prepare(
      `insert into session_chats (session_id, chat_id, updated_at) values (?, ?, ?)
       on conflict(session_id, chat_id) do update set updated_at=excluded.updated_at`
    ).run(sessionId, chatId, Date.now());
  }

  listSessionChats(sessionId: string): number[] {
    return (this.db.prepare("select chat_id from session_chats where session_id = ? order by updated_at desc")
      .all(sessionId) as Array<{ chat_id: number }>).map((row) => row.chat_id);
  }

  setMessageThread(chatId: number, messageId: number, sessionId: string): void {
    this.db.prepare(
      `insert into telegram_thread_messages (chat_id, message_id, session_id, created_at) values (?, ?, ?, ?)
       on conflict(chat_id, message_id) do update set session_id=excluded.session_id, created_at=excluded.created_at`
    ).run(chatId, messageId, sessionId, Date.now());
  }

  getMessageThread(chatId: number, messageId: number): string | undefined {
    const row = this.db.prepare("select session_id from telegram_thread_messages where chat_id = ? and message_id = ?")
      .get(chatId, messageId) as { session_id: string } | undefined;
    return row?.session_id;
  }

  getSessionResourceVersion(sessionId: string): number | undefined {
    const thread = this.db.prepare("select updated_at from codex_threads where id = ?").get(sessionId) as { updated_at: number } | undefined;
    return thread?.updated_at;
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
        connection_generation integer,
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

      create table if not exists legacy_tmux_attachments (
        id text primary key,
        target text not null,
        label text not null,
        cwd text,
        chat_id integer not null,
        status text not null,
        input_status text not null,
        submit_strategy text not null,
        last_probe text,
        last_probe_at integer,
        created_at integer not null,
        updated_at integer not null
      );

      create table if not exists codex_threads (
        id text primary key,
        codex_thread_id text not null unique,
        label text not null,
        cwd text,
        lifecycle_status text not null default 'available',
        paused integer not null default 0,
        created_at integer not null,
        updated_at integer not null
      );

      create table if not exists appserver_attachments (
        thread_id text primary key,
        status text not null,
        connection_generation integer,
        attached_at integer not null,
        updated_at integer not null
      );

      create table if not exists active_turns (
        thread_id text primary key,
        codex_turn_id text not null,
        status text not null,
        started_at integer not null,
        updated_at integer not null
      );

      create table if not exists pending_actions (
        id text primary key,
        kind text not null,
        session_id text not null,
        request_id text,
        request_id_type text,
        connection_generation integer,
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
        telegram_message_id integer,
        failure_reason text
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
        user_id integer,
        operation text not null,
        payload_json text not null,
        expires_at integer not null,
        created_at integer not null,
        claim_id text,
        claimed_at integer,
        consumed_at integer
      );

      create table if not exists routing_composes (
        chat_id integer not null,
        user_id integer not null,
        session_id text not null,
        expected_version integer not null,
        expires_at integer not null,
        created_at integer not null,
        primary key (chat_id, user_id)
      );

      create table if not exists sticky_routes (
        chat_id integer not null,
        user_id integer not null,
        session_id text not null,
        updated_at integer not null,
        primary key (chat_id, user_id)
      );

      create table if not exists session_chats (
        session_id text not null,
        chat_id integer not null,
        updated_at integer not null,
        primary key (session_id, chat_id)
      );

      create table if not exists telegram_thread_messages (
        chat_id integer not null,
        message_id integer not null,
        session_id text not null,
        created_at integer not null,
        primary key (chat_id, message_id)
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
    this.addColumnIfMissing("pending_actions", "connection_generation", "integer");
    this.addColumnIfMissing("pending_actions", "failure_reason", "text");
    this.addColumnIfMissing("callback_tokens", "user_id", "integer");
    this.addColumnIfMissing("callback_tokens", "claim_id", "text");
    this.addColumnIfMissing("callback_tokens", "claimed_at", "integer");
    this.addColumnIfMissing("sessions", "connection_generation", "integer");
    this.migrateLegacyAppServerSessions();
    this.migrateLegacyTmuxSessions();
    this.db.exec("drop table sessions");
    this.reconcilePersistedAppServerRuntime();
  }

  private upsertCodexThread(session: SessionRef, status: SessionStatus): StoredSession {
    const existing = this.getSessionByCodexThreadId(session.codexThreadId);
    const id = existing?.id ?? session.id;
    const now = Date.now();
    this.db.prepare(
      `insert into codex_threads (id, codex_thread_id, label, cwd, lifecycle_status, paused, created_at, updated_at)
       values (?, ?, ?, ?, 'available', 0, ?, ?)
       on conflict(codex_thread_id) do update set
         label=excluded.label,
         cwd=coalesce(excluded.cwd, codex_threads.cwd),
         lifecycle_status='available',
         updated_at=excluded.updated_at`
    ).run(id, session.codexThreadId, session.label, session.cwd ?? null, now, now);
    this.upsertAttachment(id, status, session.connectionGeneration);
    return this.getSession(id)!;
  }

  private upsertAttachment(sessionId: string, status: SessionStatus, connectionGeneration?: number): void {
    const now = Date.now();
    const attachmentStatus = status === "starting" || status === "attached" || status === "idle" || status === "active" || status === "blocked" || status === "error"
      ? status
      : "attached";
    this.db.prepare(
      `insert into appserver_attachments (thread_id, status, connection_generation, attached_at, updated_at)
       values (?, ?, ?, ?, ?)
       on conflict(thread_id) do update set
         status=excluded.status,
         connection_generation=coalesce(excluded.connection_generation, appserver_attachments.connection_generation),
         updated_at=excluded.updated_at`
    ).run(sessionId, attachmentStatus, connectionGeneration ?? null, now, now);
    this.db.prepare("update codex_threads set updated_at = ? where id = ?").run(now, sessionId);
  }

  private getCodexThreadRow(sessionId: string): Row | undefined {
    return this.db.prepare(`${CODEX_THREAD_SELECT} where t.id = ?`).get(sessionId) as Row | undefined;
  }

  private migrateLegacyAppServerSessions(): void {
    const legacyRows = this.db.prepare(
      `select * from sessions
       where adapter = 'appserver' and codex_thread_id is not null
       order by codex_thread_id, updated_at desc, id desc`
    ).all() as Row[];
    if (legacyRows.length === 0) return;

    const groups = new Map<string, Row[]>();
    for (const row of legacyRows) {
      const threadId = String(row.codex_thread_id);
      const group = groups.get(threadId) ?? [];
      group.push(row);
      groups.set(threadId, group);
    }

    const transaction = this.db.transaction(() => {
      for (const [codexThreadId, rows] of groups) {
        const canonical = rows[0]!;
        const normalized = this.db.prepare("select id from codex_threads where codex_thread_id = ?").get(codexThreadId) as { id: string } | undefined;
        const canonicalId = normalized?.id ?? String(canonical.id);
        const ids = rows.map((row) => String(row.id));
        const stateIds = ids.includes(canonicalId) ? ids : [...ids, canonicalId];
        const marks = ids.map(() => "?").join(", ");
        const createdAt = Math.min(...rows.map((row) => Number(row.created_at)));
        const updatedAt = Math.max(...rows.map((row) => Number(row.updated_at)));

        this.db.prepare(
          `insert into codex_threads (id, codex_thread_id, label, cwd, lifecycle_status, paused, created_at, updated_at)
           values (?, ?, ?, ?, 'available', ?, ?, ?)
           on conflict(codex_thread_id) do nothing`
        ).run(
          canonicalId,
          codexThreadId,
          String(canonical.label),
          canonical.cwd == null ? null : String(canonical.cwd),
          Number(canonical.paused) === 1 ? 1 : 0,
          createdAt,
          updatedAt
        );

        this.mergeTokenUsage(stateIds, canonicalId);
        this.mergeSessionRuntime(stateIds, canonicalId);
        for (const table of ["pending_actions", "event_log", "transcript_chunks", "session_grants"]) {
          this.db.prepare(`update ${table} set session_id = ? where session_id in (${marks})`).run(canonicalId, ...ids);
        }

        const lastActive = this.getRuntimeValue<string>("last_active_session_id");
        if (lastActive && ids.includes(lastActive)) this.setRuntimeValue("last_active_session_id", canonicalId);
        this.db.prepare(`delete from sessions where id in (${marks})`).run(...ids);
      }
    });
    transaction();
  }

  private migrateLegacyTmuxSessions(): void {
    const rows = this.db.prepare("select * from sessions where adapter = 'pty'").all() as Row[];
    if (rows.length === 0) return;
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        if (row.tmux_target) {
          this.db.prepare(
            `insert into legacy_tmux_attachments
              (id, target, label, cwd, chat_id, status, input_status, submit_strategy, last_probe, last_probe_at, created_at, updated_at)
             values (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
             on conflict(id) do nothing`
          ).run(
            String(row.id),
            String(row.tmux_target),
            String(row.label),
            row.cwd ?? null,
            row.status === "stopped" ? "stale" : "attached",
            row.attach_status ?? "unknown",
            row.submit_strategy ?? "enter",
            row.last_probe ?? null,
            row.last_probe_at ?? null,
            Number(row.created_at),
            Number(row.updated_at)
          );
        }
      }
      this.db.prepare("delete from sessions where adapter = 'pty'").run();
    });
    transaction();
  }

  private reconcilePersistedAppServerRuntime(): void {
    const now = Date.now();
    this.db.prepare("delete from active_turns").run();
    this.db.prepare(
      "update appserver_attachments set status = 'detached', connection_generation = null, updated_at = ? where status != 'detached' or connection_generation is not null"
    ).run(now);
  }

  private mergeTokenUsage(sessionIds: string[], canonicalId: string): void {
    const marks = sessionIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`select * from token_usage where session_id in (${marks}) order by updated_at desc, session_id desc`).all(...sessionIds) as Row[];
    if (rows.length === 0) return;
    const newest = rows[0]!;
    this.db.prepare(`delete from token_usage where session_id in (${marks})`).run(...sessionIds);
    this.db.prepare(
      `insert into token_usage
        (session_id, updated_at, total_tokens, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens,
         last_total_tokens, last_input_tokens, last_cached_input_tokens, last_output_tokens, last_reasoning_output_tokens,
         model_context_window)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      canonicalId,
      newest.updated_at,
      newest.total_tokens,
      newest.input_tokens,
      newest.cached_input_tokens,
      newest.output_tokens,
      newest.reasoning_output_tokens,
      newest.last_total_tokens,
      newest.last_input_tokens,
      newest.last_cached_input_tokens,
      newest.last_output_tokens,
      newest.last_reasoning_output_tokens,
      newest.model_context_window ?? null
    );
  }

  private mergeSessionRuntime(sessionIds: string[], canonicalId: string): void {
    const marks = sessionIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`select * from session_runtime where session_id in (${marks}) order by updated_at desc, session_id desc`).all(...sessionIds) as Row[];
    if (rows.length === 0) return;
    const newestValue = (column: string): unknown => rows.find((row) => row[column] != null)?.[column] ?? null;
    const updatedAt = Math.max(...rows.map((row) => Number(row.updated_at)));
    this.db.prepare(`delete from session_runtime where session_id in (${marks})`).run(...sessionIds);
    this.db.prepare(
      "insert into session_runtime (session_id, progress_json, diff_text, goal_json, updated_at) values (?, ?, ?, ?, ?)"
    ).run(canonicalId, newestValue("progress_json"), newestValue("diff_text"), newestValue("goal_json"), updatedAt);
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

function mapCodexThread(row: Row): StoredSession {
  const lifecycle = String(row.lifecycle_status);
  const attachmentStatus = row.attachment_status == null ? "detached" : String(row.attachment_status);
  const status: SessionStatus = lifecycle === "archived"
    ? "archived"
    : row.codex_turn_id
      ? "active"
      : isSessionStatus(attachmentStatus)
        ? attachmentStatus
        : "detached";
  const updatedAt = Math.max(
    Number(row.updated_at),
    Number(row.attachment_updated_at ?? 0),
    Number(row.turn_updated_at ?? 0)
  );
  const session: StoredSession = {
    id: String(row.id),
    adapter: "appserver",
    label: String(row.label),
    codexThreadId: String(row.codex_thread_id),
    status,
    paused: Number(row.paused) === 1,
    createdAt: Number(row.created_at),
    updatedAt
  };
  if (row.cwd) session.cwd = String(row.cwd);
  if (row.codex_turn_id) session.activeTurnId = String(row.codex_turn_id);
  if (row.connection_generation != null) session.connectionGeneration = Number(row.connection_generation);
  return session;
}

function isSessionStatus(value: string): value is SessionStatus {
  return value === "starting" || value === "attached" || value === "idle" || value === "active" ||
    value === "paused" || value === "blocked" || value === "error" || value === "detached" ||
    value === "archived" || value === "stopped";
}

function mapLegacyTmuxAttachment(row: Row): LegacyTmuxAttachment {
  const attachment: LegacyTmuxAttachment = {
    id: String(row.id),
    target: String(row.target),
    label: String(row.label),
    chatId: Number(row.chat_id),
    status: row.status as LegacyTmuxStatus,
    inputStatus: row.input_status as LegacyTmuxInputStatus,
    submitStrategy: String(row.submit_strategy),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
  if (row.cwd) attachment.cwd = String(row.cwd);
  if (row.last_probe) attachment.lastProbe = String(row.last_probe);
  if (row.last_probe_at) attachment.lastProbeAt = Number(row.last_probe_at);
  return attachment;
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
  if (row.connection_generation != null) action.connectionGeneration = Number(row.connection_generation);
  if (row.thread_id) action.threadId = String(row.thread_id);
  if (row.turn_id) action.turnId = String(row.turn_id);
  if (row.item_id) action.itemId = String(row.item_id);
  if (row.resolved_at) action.resolvedAt = Number(row.resolved_at);
  if (row.failure_reason) action.failureReason = String(row.failure_reason);
  return action;
}

function mapCallbackToken(row: Row): CallbackToken {
  const token: CallbackToken = {
    token: String(row.token),
    actionId: String(row.action_id),
    chatId: Number(row.chat_id),
    operation: String(row.operation),
    payload: JSON.parse(String(row.payload_json)),
    expiresAt: Number(row.expires_at)
  };
  if (row.user_id != null) token.userId = Number(row.user_id);
  return token;
}

function mapRoutingCompose(row: Row): RoutingCompose {
  return {
    chatId: Number(row.chat_id),
    userId: Number(row.user_id),
    sessionId: String(row.session_id),
    expectedVersion: Number(row.expected_version),
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
