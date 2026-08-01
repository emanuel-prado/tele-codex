import type Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 5;

export interface Migration {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

export class MigrationError extends Error {
  constructor(readonly version: number, readonly migrationName: string, cause: unknown) {
    super(`Database migration ${version} (${migrationName}) failed; all changes were rolled back. ${message(cause)}`, { cause });
    this.name = "MigrationError";
  }
}

export function migrateDatabase(db: Database.Database, migrations: readonly Migration[] = MIGRATIONS): number {
  db.exec(`
    create table if not exists schema_migrations (
      version integer primary key,
      name text not null,
      applied_at integer not null
    )
  `);

  const applied = new Set(
    (db.prepare("select version from schema_migrations order by version").all() as Array<{ version: number }>)
      .map((row) => Number(row.version))
  );
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  for (const migration of ordered) {
    if (applied.has(migration.version)) continue;
    try {
      db.transaction(() => {
        migration.up(db);
        db.prepare("insert into schema_migrations (version, name, applied_at) values (?, ?, ?)")
          .run(migration.version, migration.name, Date.now());
      })();
    } catch (error) {
      throw new MigrationError(migration.version, migration.name, error);
    }
  }
  return schemaVersion(db);
}

export function schemaVersion(db: Database.Database): number {
  const row = db.prepare("select coalesce(max(version), 0) as version from schema_migrations").get() as { version: number };
  return Number(row.version);
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "legacy-baseline",
    up(db) {
      db.exec(`
        create table if not exists sessions (
          id text primary key, adapter text not null, label text not null, cwd text,
          codex_thread_id text, connection_generation integer, tmux_target text, status text not null,
          paused integer not null default 0, active_turn_id text, attach_status text,
          submit_strategy text, last_probe text, last_probe_at integer,
          created_at integer not null, updated_at integer not null
        );
        create table if not exists pending_actions (
          id text primary key, kind text not null, session_id text not null, request_id text,
          request_id_type text, connection_generation integer, thread_id text, turn_id text, item_id text,
          title text not null, body text not null, payload_json text not null, nonce text not null,
          status text not null, expires_at integer not null, created_at integer not null, resolved_at integer,
          telegram_chat_id integer, telegram_message_id integer, failure_reason text
        );
        create table if not exists event_log (
          id integer primary key autoincrement, session_id text not null, timestamp integer not null,
          type text not null, severity text not null, text text not null, payload_json text
        );
        create table if not exists session_grants (
          id integer primary key autoincrement, action_id text not null, session_id text not null,
          payload_json text not null, expires_at integer not null, created_at integer not null,
          revoked integer not null default 0
        );
        create table if not exists transcript_chunks (
          id integer primary key autoincrement, session_id text not null, timestamp integer not null,
          text text not null, metadata_json text
        );
        create table if not exists token_usage (
          session_id text primary key, updated_at integer not null, total_tokens integer not null,
          input_tokens integer not null, cached_input_tokens integer not null, output_tokens integer not null,
          reasoning_output_tokens integer not null, last_total_tokens integer not null,
          last_input_tokens integer not null, last_cached_input_tokens integer not null,
          last_output_tokens integer not null, last_reasoning_output_tokens integer not null,
          model_context_window integer
        );
        create table if not exists callback_tokens (
          token text primary key, action_id text not null, chat_id integer not null, operation text not null,
          payload_json text not null, expires_at integer not null, created_at integer not null, consumed_at integer
        );
        create table if not exists interaction_drafts (
          action_id text not null, chat_id integer not null, user_id integer not null,
          question_index integer not null, answers_json text not null, awaiting_text integer not null,
          updated_at integer not null, primary key (action_id, chat_id, user_id)
        );
        create table if not exists notification_outbox (
          id integer primary key autoincrement, event_key text not null, chat_id integer not null,
          action_id text, payload_json text not null, status text not null, attempts integer not null,
          next_attempt_at integer not null, last_error text, created_at integer not null,
          updated_at integer not null, unique(event_key, chat_id)
        );
        create table if not exists session_runtime (
          session_id text primary key, progress_json text, diff_text text, goal_json text, updated_at integer not null
        );
        create table if not exists global_runtime (
          key text primary key, value_json text not null, updated_at integer not null
        );
        create table if not exists action_messages (
          action_id text not null, chat_id integer not null, message_id integer not null,
          primary key (action_id, chat_id)
        );
      `);
      addColumn(db, "sessions", "attach_status", "text");
      addColumn(db, "sessions", "submit_strategy", "text");
      addColumn(db, "sessions", "last_probe", "text");
      addColumn(db, "sessions", "last_probe_at", "integer");
      addColumn(db, "sessions", "connection_generation", "integer");
      addColumn(db, "pending_actions", "request_id_type", "text");
      addColumn(db, "pending_actions", "connection_generation", "integer");
      addColumn(db, "pending_actions", "failure_reason", "text");
    }
  },
  {
    version: 2,
    name: "normalize-codex-thread-lifecycle",
    up(db) {
      db.exec(`
        create table if not exists codex_threads (
          id text primary key, codex_thread_id text not null unique, label text not null, cwd text,
          lifecycle_status text not null default 'available', paused integer not null default 0,
          created_at integer not null, updated_at integer not null
        );
        create table if not exists appserver_attachments (
          thread_id text primary key, status text not null, connection_generation integer,
          attached_at integer not null, updated_at integer not null
        );
        create table if not exists active_turns (
          thread_id text primary key, codex_turn_id text not null, status text not null,
          started_at integer not null, updated_at integer not null
        );
        create table if not exists legacy_tmux_attachments (
          id text primary key, target text not null, label text not null, cwd text, chat_id integer not null,
          status text not null, input_status text not null, submit_strategy text not null,
          last_probe text, last_probe_at integer, created_at integer not null, updated_at integer not null
        );
      `);
      migrateLegacySessions(db);
      db.exec("drop table if exists sessions");
    }
  },
  {
    version: 3,
    name: "scoped-routing-and-callback-claims",
    up(db) {
      addColumn(db, "callback_tokens", "user_id", "integer");
      addColumn(db, "callback_tokens", "claim_id", "text");
      addColumn(db, "callback_tokens", "claimed_at", "integer");
      db.exec(`
        create table if not exists routing_composes (
          chat_id integer not null, user_id integer not null, session_id text not null,
          expected_version integer not null, expires_at integer not null, created_at integer not null,
          primary key (chat_id, user_id)
        );
        create table if not exists sticky_routes (
          chat_id integer not null, user_id integer not null, session_id text not null,
          updated_at integer not null, primary key (chat_id, user_id)
        );
        create table if not exists session_chats (
          session_id text not null, chat_id integer not null, updated_at integer not null,
          primary key (session_id, chat_id)
        );
        create table if not exists telegram_thread_messages (
          chat_id integer not null, message_id integer not null, session_id text not null,
          created_at integer not null, primary key (chat_id, message_id)
        );
      `);
    }
  },
  {
    version: 4,
    name: "bounded-transcripts-and-maintenance",
    up(db) {
      addColumn(db, "transcript_chunks", "turn_id", "text");
      addColumn(db, "transcript_chunks", "item_id", "text");
      addColumn(db, "transcript_chunks", "chunk_index", "integer");
      addColumn(db, "transcript_chunks", "finalized_at", "integer");
      db.exec(`
        update transcript_chunks set chunk_index = id where chunk_index is null;
        update transcript_chunks set finalized_at = timestamp where finalized_at is null;
        create index if not exists callback_tokens_cleanup on callback_tokens(expires_at, consumed_at);
        create index if not exists outbox_cleanup on notification_outbox(status, updated_at);
        create index if not exists pending_actions_cleanup on pending_actions(status, resolved_at, expires_at);
        create index if not exists event_log_cleanup on event_log(timestamp);
        create index if not exists transcript_retention on transcript_chunks(timestamp);
        create index if not exists transcript_identity on transcript_chunks(session_id, turn_id, item_id, chunk_index);
      `);
    }
  },
  {
    version: 5,
    name: "legacy-tmux-capture-boundaries",
    up(db) {
      addColumn(db, "legacy_tmux_attachments", "pane_identity", "text");
      addColumn(db, "legacy_tmux_attachments", "capture_position", "integer");
      addColumn(db, "legacy_tmux_attachments", "capture_hash", "text");
      addColumn(db, "legacy_tmux_attachments", "capture_tail", "text");
      addColumn(db, "legacy_tmux_attachments", "last_capture_at", "integer");
      db.exec(`
        create table if not exists legacy_tmux_observations (
          id integer primary key autoincrement,
          event_key text not null unique,
          attachment_id text not null,
          pane_identity text not null,
          capture_position integer not null,
          kind text not null,
          text text not null,
          confidence text,
          reason text,
          observed_at integer not null
        );
        create index if not exists legacy_tmux_observations_attachment
          on legacy_tmux_observations(attachment_id, observed_at);
      `);
    }
  }
];

function migrateLegacySessions(db: Database.Database): void {
  const sessions = db.prepare("select * from sessions order by updated_at desc, id desc").all() as Array<Record<string, unknown>>;
  const appserver = sessions.filter((row) => row.adapter === "appserver" && row.codex_thread_id != null);
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of appserver) groups.set(String(row.codex_thread_id), [...(groups.get(String(row.codex_thread_id)) ?? []), row]);

  for (const [codexThreadId, rows] of groups) {
    const canonical = rows[0]!;
    const existing = db.prepare("select id from codex_threads where codex_thread_id = ?").get(codexThreadId) as { id: string } | undefined;
    const canonicalId = existing?.id ?? String(canonical.id);
    const ids = rows.map((row) => String(row.id));
    const stateIds = ids.includes(canonicalId) ? ids : [...ids, canonicalId];
    const marks = ids.map(() => "?").join(", ");
    db.prepare(`insert into codex_threads
      (id, codex_thread_id, label, cwd, lifecycle_status, paused, created_at, updated_at)
      values (?, ?, ?, ?, 'available', ?, ?, ?) on conflict(codex_thread_id) do nothing`)
      .run(canonicalId, codexThreadId, String(canonical.label), canonical.cwd ?? null,
        Number(canonical.paused) === 1 ? 1 : 0,
        Math.min(...rows.map((row) => Number(row.created_at))),
        Math.max(...rows.map((row) => Number(row.updated_at))));
    mergeTokenUsage(db, stateIds, canonicalId);
    mergeRuntime(db, stateIds, canonicalId);
    for (const table of ["pending_actions", "event_log", "transcript_chunks", "session_grants"]) {
      db.prepare(`update ${table} set session_id = ? where session_id in (${marks})`).run(canonicalId, ...ids);
    }
    const active = runtimeValue<string>(db, "last_active_session_id");
    if (active && ids.includes(active)) setRuntimeValue(db, "last_active_session_id", canonicalId);
  }

  for (const row of sessions.filter((item) => item.adapter === "pty" && item.tmux_target)) {
    db.prepare(`insert into legacy_tmux_attachments
      (id, target, label, cwd, chat_id, status, input_status, submit_strategy, last_probe, last_probe_at, created_at, updated_at)
      values (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?) on conflict(id) do nothing`)
      .run(String(row.id), String(row.tmux_target), String(row.label), row.cwd ?? null,
        row.status === "stopped" ? "stale" : "attached", row.attach_status ?? "unknown",
        row.submit_strategy ?? "enter", row.last_probe ?? null, row.last_probe_at ?? null,
        Number(row.created_at), Number(row.updated_at));
  }
}

function mergeTokenUsage(db: Database.Database, sessionIds: string[], canonicalId: string): void {
  const marks = sessionIds.map(() => "?").join(", ");
  const rows = db.prepare(`select * from token_usage where session_id in (${marks}) order by updated_at desc, session_id desc`)
    .all(...sessionIds) as Array<Record<string, unknown>>;
  if (rows.length === 0) return;
  const row = rows[0]!;
  db.prepare(`delete from token_usage where session_id in (${marks})`).run(...sessionIds);
  db.prepare(`insert into token_usage values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(canonicalId, row.updated_at, row.total_tokens, row.input_tokens, row.cached_input_tokens,
      row.output_tokens, row.reasoning_output_tokens, row.last_total_tokens, row.last_input_tokens,
      row.last_cached_input_tokens, row.last_output_tokens, row.last_reasoning_output_tokens, row.model_context_window ?? null);
}

function mergeRuntime(db: Database.Database, sessionIds: string[], canonicalId: string): void {
  const marks = sessionIds.map(() => "?").join(", ");
  const rows = db.prepare(`select * from session_runtime where session_id in (${marks}) order by updated_at desc, session_id desc`)
    .all(...sessionIds) as Array<Record<string, unknown>>;
  if (rows.length === 0) return;
  const newest = (column: string) => rows.find((row) => row[column] != null)?.[column] ?? null;
  db.prepare(`delete from session_runtime where session_id in (${marks})`).run(...sessionIds);
  db.prepare("insert into session_runtime (session_id, progress_json, diff_text, goal_json, updated_at) values (?, ?, ?, ?, ?)")
    .run(canonicalId, newest("progress_json"), newest("diff_text"), newest("goal_json"), Math.max(...rows.map((row) => Number(row.updated_at))));
}

function addColumn(db: Database.Database, table: string, column: string, type: string): void {
  const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(`alter table ${table} add column ${column} ${type}`);
}

function runtimeValue<T>(db: Database.Database, key: string): T | undefined {
  const row = db.prepare("select value_json from global_runtime where key = ?").get(key) as { value_json: string } | undefined;
  return row ? JSON.parse(row.value_json) as T : undefined;
}

function setRuntimeValue(db: Database.Database, key: string, value: unknown): void {
  db.prepare(`insert into global_runtime (key, value_json, updated_at) values (?, ?, ?)
    on conflict(key) do update set value_json=excluded.value_json, updated_at=excluded.updated_at`)
    .run(key, JSON.stringify(value), Date.now());
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
