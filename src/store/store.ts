import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import type { RateLimitSummary, SessionProgress, SessionTokenUsage, ThreadGoalSummary } from "../types/control.js";
import type { LogEntry, PendingAction, SessionRef, SessionStatus } from "../types/events.js";
import type { LegacyTmuxAttachment, LegacyTmuxInputStatus, LegacyTmuxObservation, LegacyTmuxStatus } from "../types/legacy-tmux.js";
import { migrateDatabase, schemaVersion } from "./migrations.js";
import {
  InteractionRepository,
  NotificationOutboxRepository,
  RuntimeStateRepository,
  ThreadAttachmentRepository,
  TranscriptLogRepository
} from "./repositories.js";

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
  resourceKind: string;
  expectedVersion?: number;
  chatId: number;
  userId: number;
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
  answers: Record<string, { answers: string[]; value?: unknown }>;
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

export interface StorageDiagnostics {
  schemaVersion: number;
  databaseBytes: number;
  walBytes: number;
  pageCount: number;
  freelistPages: number;
  warnings: string[];
}

export interface MaintenancePolicy {
  now?: number;
  consumedCallbackRetentionMs?: number;
  completedInteractionRetentionMs?: number;
  sentOutboxRetentionMs?: number;
  logRetentionMs?: number;
  transcriptRetentionMs?: number;
}

export interface MaintenanceResult {
  callbackTokens: number;
  interactionDrafts: number;
  sentOutbox: number;
  logs: number;
  legacyTmuxObservations: number;
  actions: number;
  transcripts: number;
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
  private readonly path: string;
  private closed = false;
  readonly threads: ThreadAttachmentRepository;
  readonly interactions: InteractionRepository;
  readonly notifications: NotificationOutboxRepository;
  readonly transcripts: TranscriptLogRepository;
  readonly runtimeState: RuntimeStateRepository;

  constructor(path: string) {
    this.path = path;
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    this.threads = new ThreadAttachmentRepository(this.db);
    this.interactions = new InteractionRepository(this.db);
    this.notifications = new NotificationOutboxRepository(this.db);
    this.transcripts = new TranscriptLogRepository(this.db);
    this.runtimeState = new RuntimeStateRepository(this.db);
    this.reconcilePersistedAppServerRuntime();
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
      this.db.prepare("update codex_threads set paused = ?, updated_at = ? where id = ?")
        .run(paused ? 1 : 0, this.nextSessionVersion(sessionId), sessionId);
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
        this.db.prepare("update codex_threads set updated_at = ? where id = ?")
          .run(this.nextSessionVersion(sessionId), sessionId);
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
    const now = this.nextLegacyVersion(input.id);
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
      this.nextLegacyVersion(id),
      id
    );
  }

  updateLegacyTmuxCapture(
    id: string,
    capture: Pick<LegacyTmuxAttachment, "paneIdentity" | "capturePosition" | "captureHash" | "captureTail" | "lastCaptureAt">
  ): void {
    this.db.prepare(
      `update legacy_tmux_attachments set
        pane_identity = ?, capture_position = ?, capture_hash = ?, capture_tail = ?, last_capture_at = ?, updated_at = ?
       where id = ?`
    ).run(
      capture.paneIdentity ?? null,
      capture.capturePosition ?? null,
      capture.captureHash ?? null,
      capture.captureTail ?? null,
      capture.lastCaptureAt ?? null,
      this.nextLegacyVersion(id),
      id
    );
  }

  appendLegacyTmuxObservation(observation: LegacyTmuxObservation): boolean {
    return this.db.prepare(
      `insert into legacy_tmux_observations
        (event_key, attachment_id, pane_identity, capture_position, kind, text, confidence, reason, observed_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(event_key) do nothing`
    ).run(
      observation.eventKey,
      observation.attachmentId,
      observation.paneIdentity,
      observation.capturePosition,
      observation.kind,
      observation.text,
      observation.confidence ?? null,
      observation.reason ?? null,
      observation.observedAt
    ).changes === 1;
  }

  listLegacyTmuxObservations(attachmentId: string, limit = 50): LegacyTmuxObservation[] {
    return (this.db.prepare(
      "select * from legacy_tmux_observations where attachment_id = ? order by id desc limit ?"
    ).all(attachmentId, limit) as Row[]).reverse().map(mapLegacyTmuxObservation);
  }

  hasRecentLegacyTmuxObservation(input: {
    attachmentId: string;
    paneIdentity: string;
    kind: LegacyTmuxObservation["kind"];
    text: string;
    since: number;
  }): boolean {
    return Boolean(this.db.prepare(
      `select 1 from legacy_tmux_observations
       where attachment_id = ? and pane_identity = ? and kind = ? and text = ? and observed_at >= ? limit 1`
    ).get(input.attachmentId, input.paneIdentity, input.kind, input.text, input.since));
  }

  markThreadDetached(sessionId: string): void {
    const now = this.nextSessionVersion(sessionId);
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
    this.db.prepare("update codex_threads set lifecycle_status = 'archived', updated_at = ? where id = ?")
      .run(this.nextSessionVersion(sessionId), sessionId);
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
      for (const table of ["event_log", "transcript_chunks", "token_usage", "session_runtime"]) {
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
          (id, kind, session_id, request_id, request_id_type, connection_generation, thread_id, turn_id, item_id, title, body, payload_json, status, expires_at, created_at, failure_reason)
         values
          (@id, @kind, @sessionId, @requestId, @requestIdType, @connectionGeneration, @threadId, @turnId, @itemId, @title, @body, @payloadJson, 'pending', @expiresAt, @createdAt, null)
         on conflict(id) do update set
          body=excluded.body,
          payload_json=excluded.payload_json,
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
    return this.interactions.countPending(sessionId);
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
    this.runtimeState.set(key, value);
  }

  getRuntimeValue<T>(key: string): T | undefined {
    return this.runtimeState.get<T>(key);
  }

  deleteRuntimeValue(key: string): void {
    this.runtimeState.delete(key);
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
      `insert into callback_tokens
        (token, action_id, resource_kind, expected_version, chat_id, user_id, operation, payload_json, expires_at, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(token.token, token.actionId, token.resourceKind, token.expectedVersion ?? null, token.chatId, token.userId,
      token.operation, JSON.stringify(token.payload), token.expiresAt, Date.now());
  }

  claimCallbackToken(token: string, chatId: number, userId: number, claimId: string): ClaimedCallbackToken | undefined {
    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare("select * from callback_tokens where token = ? and chat_id = ? and user_id = ? and claim_id is null and consumed_at is null and expires_at > ?")
        .get(token, chatId, userId, Date.now()) as Row | undefined;
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
    return this.interactions.consumeCompose(chatId, userId);
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
    this.threads.rememberChat(sessionId, chatId);
  }

  listSessionChats(sessionId: string): number[] {
    return this.threads.listChats(sessionId);
  }

  setMessageThread(chatId: number, messageId: number, sessionId: string): void {
    this.threads.setMessageThread(chatId, messageId, sessionId);
  }

  getMessageThread(chatId: number, messageId: number): string | undefined {
    return this.threads.messageThread(chatId, messageId);
  }

  getSessionResourceVersion(sessionId: string): number | undefined {
    return this.threads.resourceVersion(sessionId);
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
         where d.chat_id = ? and d.user_id = ? and d.awaiting_text = 1
         order by d.updated_at desc limit 1`
      )
      .get(chatId, userId) as Row | undefined;
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
    this.notifications.enqueue(eventKey, chatId, payload, actionId);
  }

  dueOutbox(limit = 20): OutboxMessage[] {
    return this.notifications.due(limit);
  }

  markOutboxSent(id: number): void {
    this.notifications.markSent(id);
  }

  retryOutbox(id: number, attempts: number, error: string): void {
    this.notifications.retry(id, attempts, error);
  }

  outboxCounts(): { pending: number; failed: number } {
    return this.notifications.counts();
  }

  retryFailedOutbox(): number {
    return this.notifications.retryFailed();
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
    this.transcripts.appendLog(entry);
  }

  recentLogs(sessionId: string, limit: number): LogEntry[] {
    return this.transcripts.recentLogs(sessionId, limit);
  }

  appendTranscript(sessionId: string, text: string, metadata?: unknown): void {
    this.transcripts.append(sessionId, text, metadata);
  }

  finalizeTranscriptTurn(sessionId: string, turnId: string): number {
    return this.transcripts.finalizeTurn(sessionId, turnId);
  }

  getTranscript(sessionId: string): string {
    return this.transcripts.text(sessionId);
  }

  transcriptChunkCount(sessionId: string): number {
    return this.transcripts.chunkCount(sessionId);
  }

  diagnostics(databaseWarningBytes = 256 * 1024 * 1024, walWarningBytes = 64 * 1024 * 1024): StorageDiagnostics {
    const pageCount = Number(this.db.pragma("page_count", { simple: true }));
    const pageSize = Number(this.db.pragma("page_size", { simple: true }));
    const freelistPages = Number(this.db.pragma("freelist_count", { simple: true }));
    const databaseBytes = this.path === ":memory:" ? pageCount * pageSize : fileSize(this.path);
    const walBytes = this.path === ":memory:" ? 0 : fileSize(`${this.path}-wal`);
    const warnings: string[] = [];
    if (databaseBytes > databaseWarningBytes) warnings.push(`database is ${formatBytes(databaseBytes)}`);
    if (walBytes > walWarningBytes) warnings.push(`WAL is ${formatBytes(walBytes)}; run maintenance/checkpoint`);
    return { schemaVersion: schemaVersion(this.db), databaseBytes, walBytes, pageCount, freelistPages, warnings };
  }

  checkpoint(mode: "PASSIVE" | "RESTART" | "TRUNCATE" = "TRUNCATE"): void {
    this.db.pragma(`wal_checkpoint(${mode})`);
  }

  maintain(policy: MaintenancePolicy = {}): MaintenanceResult {
    const now = policy.now ?? Date.now();
    const callbackCutoff = now - (policy.consumedCallbackRetentionMs ?? 24 * 60 * 60 * 1000);
    const interactionCutoff = now - (policy.completedInteractionRetentionMs ?? 7 * 24 * 60 * 60 * 1000);
    const outboxCutoff = now - (policy.sentOutboxRetentionMs ?? 7 * 24 * 60 * 60 * 1000);
    const logCutoff = now - (policy.logRetentionMs ?? 30 * 24 * 60 * 60 * 1000);
    return this.db.transaction(() => {
      const callbackTokens = this.db.prepare(
        `delete from callback_tokens
         where (expires_at < ? or (consumed_at is not null and consumed_at < ?))
         and action_id not in (select id from pending_actions where status in ('pending', 'submitting', 'failed'))`
      ).run(now, callbackCutoff).changes;
      const interactionDrafts = this.db.prepare(
        `delete from interaction_drafts where action_id in
          (select id from pending_actions where status not in ('pending', 'submitting', 'failed') and coalesce(resolved_at, created_at) < ?)`
      ).run(interactionCutoff).changes;
      const sentOutbox = this.db.prepare(
        "delete from notification_outbox where status = 'sent' and updated_at < ?"
      ).run(outboxCutoff).changes;
      const logs = this.db.prepare("delete from event_log where timestamp < ?").run(logCutoff).changes;
      const legacyTmuxObservations = this.db.prepare("delete from legacy_tmux_observations where observed_at < ?").run(logCutoff).changes;
      this.db.prepare(
        `delete from callback_tokens where action_id in
          (select id from pending_actions where status not in ('pending', 'submitting', 'failed')
           and coalesce(resolved_at, created_at) < ?
           and id not in (select action_id from notification_outbox where action_id is not null and status != 'sent'))`
      ).run(interactionCutoff);
      this.db.prepare(
        `delete from action_messages where action_id in
          (select id from pending_actions where status not in ('pending', 'submitting', 'failed')
           and coalesce(resolved_at, created_at) < ?
           and id not in (select action_id from notification_outbox where action_id is not null and status != 'sent'))`
      ).run(interactionCutoff);
      const actions = this.db.prepare(
        `delete from pending_actions where status not in ('pending', 'submitting', 'failed')
         and coalesce(resolved_at, created_at) < ?
         and id not in (select action_id from notification_outbox where action_id is not null and status != 'sent')`
      ).run(interactionCutoff).changes;
      const transcripts = policy.transcriptRetentionMs === undefined ? 0 : this.db.prepare(
        "delete from transcript_chunks where timestamp < ? and finalized_at is not null"
      ).run(now - policy.transcriptRetentionMs).changes;
      return { callbackTokens, interactionDrafts, sentOutbox, logs, legacyTmuxObservations, actions, transcripts };
    })();
  }

  private migrate(): void {
    migrateDatabase(this.db);
  }

  private upsertCodexThread(session: SessionRef, status: SessionStatus): StoredSession {
    const existing = this.getSessionByCodexThreadId(session.codexThreadId);
    const id = existing?.id ?? session.id;
    const now = existing ? this.nextSessionVersion(existing.id) : Date.now();
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
    const now = this.nextSessionVersion(sessionId);
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

  private nextSessionVersion(sessionId: string): number {
    const current = this.threads.resourceVersion(sessionId) ?? 0;
    return Math.max(Date.now(), current + 1);
  }

  private nextLegacyVersion(attachmentId: string): number {
    const row = this.db.prepare("select updated_at from legacy_tmux_attachments where id = ?")
      .get(attachmentId) as { updated_at: number } | undefined;
    return Math.max(Date.now(), Number(row?.updated_at ?? 0) + 1);
  }

  private getCodexThreadRow(sessionId: string): Row | undefined {
    return this.db.prepare(`${CODEX_THREAD_SELECT} where t.id = ?`).get(sessionId) as Row | undefined;
  }

  private reconcilePersistedAppServerRuntime(): void {
    const now = Date.now();
    this.db.prepare("delete from active_turns").run();
    this.db.prepare(
      "update appserver_attachments set status = 'detached', connection_generation = null, updated_at = ? where status != 'detached' or connection_generation is not null"
    ).run(now);
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

function fileSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
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
  if (row.pane_identity) attachment.paneIdentity = String(row.pane_identity);
  if (row.capture_position != null) attachment.capturePosition = Number(row.capture_position);
  if (row.capture_hash) attachment.captureHash = String(row.capture_hash);
  if (row.capture_tail) attachment.captureTail = String(row.capture_tail);
  if (row.last_capture_at != null) attachment.lastCaptureAt = Number(row.last_capture_at);
  return attachment;
}

function mapLegacyTmuxObservation(row: Row): LegacyTmuxObservation {
  return {
    eventKey: String(row.event_key),
    attachmentId: String(row.attachment_id),
    paneIdentity: String(row.pane_identity),
    capturePosition: Number(row.capture_position),
    kind: row.kind as LegacyTmuxObservation["kind"],
    text: String(row.text),
    ...(row.confidence ? { confidence: row.confidence as "high" | "medium" | "low" } : {}),
    ...(row.reason ? { reason: String(row.reason) } : {}),
    observedAt: Number(row.observed_at)
  };
}

function mapPendingAction(row: Row): StoredPendingAction {
  const action: StoredPendingAction = {
    id: String(row.id),
    kind: row.kind as PendingAction["kind"],
    sessionId: String(row.session_id),
    title: String(row.title),
    body: String(row.body),
    payload: JSON.parse(String(row.payload_json)),
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
    resourceKind: String(row.resource_kind),
    chatId: Number(row.chat_id),
    userId: Number(row.user_id),
    operation: String(row.operation),
    payload: JSON.parse(String(row.payload_json)),
    expiresAt: Number(row.expires_at)
  };
  if (row.expected_version != null) token.expectedVersion = Number(row.expected_version);
  return token;
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
