import type Database from "better-sqlite3";
import type { RateLimitSummary, SessionProgress, SessionTokenUsage, ThreadGoalSummary } from "../types/control.js";
import type { LogEntry } from "../types/events.js";
import type { OutboxMessage, RoutingCompose } from "./store.js";
import { sanitizeDiagnosticText } from "../runtime/diagnostics.js";

type Row = Record<string, unknown>;

export class ThreadAttachmentRepository {
  constructor(private readonly db: Database.Database) {}

  resourceVersion(sessionId: string): number | undefined {
    const row = this.db.prepare("select updated_at from codex_threads where id = ?").get(sessionId) as { updated_at: number } | undefined;
    return row?.updated_at;
  }

  rememberChat(sessionId: string, chatId: number): void {
    this.db.prepare(`insert into session_chats (session_id, chat_id, updated_at) values (?, ?, ?)
      on conflict(session_id, chat_id) do update set updated_at=excluded.updated_at`).run(sessionId, chatId, Date.now());
  }

  listChats(sessionId: string): number[] {
    return (this.db.prepare("select chat_id from session_chats where session_id = ? order by updated_at desc")
      .all(sessionId) as Array<{ chat_id: number }>).map((row) => row.chat_id);
  }

  setMessageThread(chatId: number, messageId: number, sessionId: string): void {
    this.db.prepare(`insert into telegram_thread_messages (chat_id, message_id, session_id, created_at) values (?, ?, ?, ?)
      on conflict(chat_id, message_id) do update set session_id=excluded.session_id, created_at=excluded.created_at`)
      .run(chatId, messageId, sessionId, Date.now());
  }

  messageThread(chatId: number, messageId: number): string | undefined {
    return (this.db.prepare("select session_id from telegram_thread_messages where chat_id = ? and message_id = ?")
      .get(chatId, messageId) as { session_id: string } | undefined)?.session_id;
  }
}

export class InteractionRepository {
  constructor(private readonly db: Database.Database) {}

  countPending(sessionId?: string, now = Date.now()): number {
    const row = sessionId
      ? this.db.prepare("select count(*) as count from pending_actions where session_id = ? and status in ('pending', 'failed') and expires_at > ?").get(sessionId, now)
      : this.db.prepare("select count(*) as count from pending_actions where status in ('pending', 'failed') and expires_at > ?").get(now);
    return Number((row as { count: number }).count);
  }

  consumeCompose(chatId: number, userId: number, now = Date.now()): RoutingCompose | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare("select * from routing_composes where chat_id = ? and user_id = ? and expires_at > ?")
        .get(chatId, userId, now) as Row | undefined;
      this.db.prepare("delete from routing_composes where chat_id = ? and user_id = ?").run(chatId, userId);
      return row ? {
        chatId: Number(row.chat_id), userId: Number(row.user_id), sessionId: String(row.session_id),
        expectedVersion: Number(row.expected_version), expiresAt: Number(row.expires_at)
      } : undefined;
    })();
  }
}

export class NotificationOutboxRepository {
  constructor(private readonly db: Database.Database) {}

  enqueue(eventKey: string, chatId: number, payload: OutboxMessage["payload"], actionId?: string): void {
    this.db.prepare(`insert into notification_outbox
      (event_key, chat_id, action_id, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
      values (?, ?, ?, ?, 'pending', 0, ?, ?, ?) on conflict(event_key, chat_id) do nothing`)
      .run(eventKey, chatId, actionId ?? null, JSON.stringify(payload), Date.now(), Date.now(), Date.now());
  }

  due(limit = 20, now = Date.now()): OutboxMessage[] {
    return (this.db.prepare(`select * from notification_outbox where status = 'pending' and next_attempt_at <= ? order by id limit ?`)
      .all(now, limit) as Row[]).map((row) => ({
        id: Number(row.id), eventKey: String(row.event_key), chatId: Number(row.chat_id),
        ...(row.action_id ? { actionId: String(row.action_id) } : {}),
        payload: JSON.parse(String(row.payload_json)) as OutboxMessage["payload"], attempts: Number(row.attempts)
      }));
  }

  markSent(id: number, now = Date.now()): void {
    this.db.prepare("update notification_outbox set status = 'sent', payload_json = '{}', last_error = null, updated_at = ? where id = ?")
      .run(now, id);
  }

  retry(id: number, attempts: number, error: string, now = Date.now()): void {
    const status = attempts >= 20 ? "failed" : "pending";
    const delay = Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8));
    this.db.prepare("update notification_outbox set status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? where id = ?")
      .run(status, attempts, now + delay, sanitizeDiagnosticText(error).slice(0, 1000), now, id);
  }

  counts(): { pending: number; failed: number } {
    const rows = this.db.prepare("select status, count(*) as count from notification_outbox where status in ('pending', 'failed') group by status")
      .all() as Array<{ status: string; count: number }>;
    return {
      pending: Number(rows.find((row) => row.status === "pending")?.count ?? 0),
      failed: Number(rows.find((row) => row.status === "failed")?.count ?? 0)
    };
  }

  retryFailed(now = Date.now()): number {
    return this.db.prepare("update notification_outbox set status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ? where status = 'failed'")
      .run(now, now).changes;
  }
}

export class EventLogRepository {
  constructor(private readonly db: Database.Database) {}

  appendLog(entry: Omit<LogEntry, "id" | "timestamp"> & { timestamp?: number }): void {
    this.db.prepare(`insert into event_log (session_id, timestamp, type, severity, text, payload_json) values (?, ?, ?, ?, ?, ?)`)
      .run(entry.sessionId, entry.timestamp ?? Date.now(), entry.type, entry.severity,
        sanitizeDiagnosticText(entry.text), null);
  }

  recentLogs(sessionId: string, limit: number): LogEntry[] {
    return (this.db.prepare("select * from event_log where session_id = ? order by id desc limit ?").all(sessionId, limit) as Row[])
      .reverse().map((row) => ({
        id: Number(row.id), sessionId: String(row.session_id), timestamp: Number(row.timestamp),
        type: String(row.type), severity: row.severity as LogEntry["severity"], text: String(row.text),
        ...(row.payload_json ? { payload: JSON.parse(String(row.payload_json)) } : {})
      }));
  }
}

export class TranscriptRepository {
  constructor(private readonly db: Database.Database, private readonly maxChunkBytes = 32 * 1024) {}

  append(sessionId: string, text: string, metadata?: unknown): void {
    const identity = transcriptIdentity(metadata);
    const now = Date.now();
    if (identity.turnId && identity.itemId) {
      const row = this.db.prepare(`select id, text, chunk_index from transcript_chunks
        where session_id = ? and turn_id = ? and item_id = ? and finalized_at is null
        order by chunk_index desc limit 1`).get(sessionId, identity.turnId, identity.itemId) as
        { id: number; text: string; chunk_index: number } | undefined;
      if (row && Buffer.byteLength(row.text + text, "utf8") <= this.maxChunkBytes) {
        this.db.prepare("update transcript_chunks set text = text || ? where id = ?").run(text, row.id);
        return;
      }
      this.db.prepare(`insert into transcript_chunks
        (session_id, timestamp, text, metadata_json, turn_id, item_id, chunk_index, finalized_at)
        values (?, ?, ?, ?, ?, ?, ?, null)`)
        .run(sessionId, now, text, metadata === undefined ? null : JSON.stringify(metadata), identity.turnId,
          identity.itemId, row ? Number(row.chunk_index) + 1 : 0);
      return;
    }
    this.db.prepare(`insert into transcript_chunks
      (session_id, timestamp, text, metadata_json, turn_id, item_id, chunk_index, finalized_at)
      values (?, ?, ?, ?, ?, ?, 0, ?)`)
      .run(sessionId, now, text, metadata === undefined ? null : JSON.stringify(metadata),
        identity.turnId ?? null, identity.itemId ?? null, now);
  }

  finalizeTurn(sessionId: string, turnId: string, now = Date.now()): number {
    return this.db.prepare("update transcript_chunks set finalized_at = ? where session_id = ? and turn_id = ? and finalized_at is null")
      .run(now, sessionId, turnId).changes;
  }

  text(sessionId: string): string {
    const rows = this.db.prepare("select id, timestamp, text, turn_id, item_id from transcript_chunks where session_id = ? order by id asc")
      .all(sessionId) as Array<{ id: number; timestamp: number; text: string; turn_id: string | null; item_id: string | null }>;
    const entries: Array<{ timestamp: number; text: string; identity?: string }> = [];
    for (const row of rows) {
      const identity = row.turn_id && row.item_id ? `${row.turn_id}\u0000${row.item_id}` : undefined;
      const previous = entries.at(-1);
      if (identity && previous?.identity === identity) previous.text += row.text;
      else entries.push({ timestamp: row.timestamp, text: row.text, ...(identity ? { identity } : {}) });
    }
    return entries.map((row) => `[${new Date(Number(row.timestamp)).toISOString()}]\n${String(row.text).trim()}`).join("\n\n");
  }

  chunkCount(sessionId: string): number {
    return Number((this.db.prepare("select count(*) as count from transcript_chunks where session_id = ?").get(sessionId) as { count: number }).count);
  }
}

export class RuntimeStateRepository {
  constructor(private readonly db: Database.Database) {}

  set(key: string, value: unknown, now = Date.now()): void {
    this.db.prepare(`insert into global_runtime (key, value_json, updated_at) values (?, ?, ?)
      on conflict(key) do update set value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), now);
  }

  get<T>(key: string): T | undefined {
    const row = this.db.prepare("select value_json from global_runtime where key = ?").get(key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as T : undefined;
  }

  delete(key: string): void {
    this.db.prepare("delete from global_runtime where key = ?").run(key);
  }

  setRateLimits(limits: RateLimitSummary): void {
    this.set("rate_limits", limits);
  }

  getRateLimits(): RateLimitSummary | undefined {
    return this.get<RateLimitSummary>("rate_limits");
  }
}

export class ThreadRuntimeRepository {
  constructor(private readonly db: Database.Database) {}

  setTokenUsage(sessionId: string, usage: Omit<SessionTokenUsage, "updatedAt"> & { updatedAt?: number }): void {
    this.db.prepare(
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
    ).run({
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
    this.upsertSessionState(sessionId, "progress_json", JSON.stringify(progress));
  }

  getProgress(sessionId: string): SessionProgress | undefined {
    const row = this.db.prepare("select progress_json from session_runtime where session_id = ?").get(sessionId) as Row | undefined;
    return row?.progress_json ? JSON.parse(String(row.progress_json)) as SessionProgress : undefined;
  }

  setDiff(sessionId: string, diff: string): void {
    this.upsertSessionState(sessionId, "diff_text", diff);
  }

  getDiff(sessionId: string): string | undefined {
    const row = this.db.prepare("select diff_text from session_runtime where session_id = ?").get(sessionId) as Row | undefined;
    return row?.diff_text ? String(row.diff_text) : undefined;
  }

  setGoal(sessionId: string, goal: ThreadGoalSummary | undefined): void {
    this.upsertSessionState(sessionId, "goal_json", goal ? JSON.stringify(goal) : null);
  }

  getGoal(sessionId: string): ThreadGoalSummary | undefined {
    const row = this.db.prepare("select goal_json from session_runtime where session_id = ?").get(sessionId) as Row | undefined;
    return row?.goal_json ? JSON.parse(String(row.goal_json)) as ThreadGoalSummary : undefined;
  }

  reparentLegacySessions(sessionIds: string[], canonicalId: string): void {
    const marks = sessionIds.map(() => "?").join(", ");
    const usageRows = this.db.prepare(
      `select * from token_usage where session_id in (${marks}) order by updated_at desc, session_id desc`
    ).all(...sessionIds) as Row[];
    if (usageRows.length > 0) {
      const usage = usageRows[0]!;
      this.db.prepare(`delete from token_usage where session_id in (${marks})`).run(...sessionIds);
      this.db.prepare("insert into token_usage values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(canonicalId, usage.updated_at, usage.total_tokens, usage.input_tokens, usage.cached_input_tokens,
          usage.output_tokens, usage.reasoning_output_tokens, usage.last_total_tokens, usage.last_input_tokens,
          usage.last_cached_input_tokens, usage.last_output_tokens, usage.last_reasoning_output_tokens,
          usage.model_context_window ?? null);
    }

    const runtimeRows = this.db.prepare(
      `select * from session_runtime where session_id in (${marks}) order by updated_at desc, session_id desc`
    ).all(...sessionIds) as Row[];
    if (runtimeRows.length === 0) return;
    const newest = (column: string) => runtimeRows.find((row) => row[column] != null)?.[column] ?? null;
    this.db.prepare(`delete from session_runtime where session_id in (${marks})`).run(...sessionIds);
    this.db.prepare(
      "insert into session_runtime (session_id, progress_json, diff_text, goal_json, updated_at) values (?, ?, ?, ?, ?)"
    ).run(canonicalId, newest("progress_json"), newest("diff_text"), newest("goal_json"),
      Math.max(...runtimeRows.map((row) => Number(row.updated_at))));
  }

  deleteSession(sessionId: string): void {
    this.db.prepare("delete from token_usage where session_id = ?").run(sessionId);
    this.db.prepare("delete from session_runtime where session_id = ?").run(sessionId);
  }

  private upsertSessionState(
    sessionId: string,
    column: "progress_json" | "diff_text" | "goal_json",
    value: string | null
  ): void {
    this.db.prepare(
      `insert into session_runtime (session_id, ${column}, updated_at) values (?, ?, ?)
       on conflict(session_id) do update set ${column}=excluded.${column}, updated_at=excluded.updated_at`
    ).run(sessionId, value, Date.now());
  }
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

function transcriptIdentity(metadata: unknown): { turnId?: string; itemId?: string } {
  if (!metadata || typeof metadata !== "object") return {};
  const value = metadata as Record<string, unknown>;
  return {
    ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
    ...(typeof value.itemId === "string" ? { itemId: value.itemId } : {})
  };
}
