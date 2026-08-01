import type Database from "better-sqlite3";
import type { LogEntry } from "../types/events.js";
import type { OutboxMessage, RoutingCompose } from "./store.js";

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
    this.db.prepare("update notification_outbox set status = 'sent', updated_at = ? where id = ?").run(now, id);
  }

  retry(id: number, attempts: number, error: string, now = Date.now()): void {
    const status = attempts >= 20 ? "failed" : "pending";
    const delay = Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8));
    this.db.prepare("update notification_outbox set status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? where id = ?")
      .run(status, attempts, now + delay, error.slice(0, 1000), now, id);
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

export class TranscriptLogRepository {
  constructor(private readonly db: Database.Database, private readonly maxChunkBytes = 32 * 1024) {}

  appendLog(entry: Omit<LogEntry, "id" | "timestamp"> & { timestamp?: number }): void {
    this.db.prepare(`insert into event_log (session_id, timestamp, type, severity, text, payload_json) values (?, ?, ?, ?, ?, ?)`)
      .run(entry.sessionId, entry.timestamp ?? Date.now(), entry.type, entry.severity, entry.text,
        entry.payload === undefined ? null : JSON.stringify(entry.payload));
  }

  recentLogs(sessionId: string, limit: number): LogEntry[] {
    return (this.db.prepare("select * from event_log where session_id = ? order by id desc limit ?").all(sessionId, limit) as Row[])
      .reverse().map((row) => ({
        id: Number(row.id), sessionId: String(row.session_id), timestamp: Number(row.timestamp),
        type: String(row.type), severity: row.severity as LogEntry["severity"], text: String(row.text),
        ...(row.payload_json ? { payload: JSON.parse(String(row.payload_json)) } : {})
      }));
  }

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
}

function transcriptIdentity(metadata: unknown): { turnId?: string; itemId?: string } {
  if (!metadata || typeof metadata !== "object") return {};
  const value = metadata as Record<string, unknown>;
  return {
    ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
    ...(typeof value.itemId === "string" ? { itemId: value.itemId } : {})
  };
}
