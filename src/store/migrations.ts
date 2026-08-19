import type Database from "better-sqlite3";
import { RuntimeStateRepository, ThreadRuntimeRepository } from "./repositories.js";

export const CURRENT_SCHEMA_VERSION = 8;

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

export class UnsupportedSchemaVersionError extends Error {
  constructor(readonly databaseVersion: number, readonly supportedVersion: number) {
    super(`Database schema version ${databaseVersion} is newer than supported version ${supportedVersion}. Upgrade tele-codex before opening this database.`);
    this.name = "UnsupportedSchemaVersionError";
  }
}

export function migrateDatabase(db: Database.Database, migrations: readonly Migration[] = MIGRATIONS): number {
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  const supportedVersion = ordered.at(-1)?.version ?? 0;
  const hasMigrationTable = Boolean(db.prepare(
    "select 1 from sqlite_master where type = 'table' and name = 'schema_migrations'"
  ).get());
  if (hasMigrationTable) {
    const databaseVersion = schemaVersion(db);
    if (databaseVersion > supportedVersion) {
      throw new UnsupportedSchemaVersionError(databaseVersion, supportedVersion);
    }
  } else {
    db.exec(`
      create table schema_migrations (
        version integer primary key,
        name text not null,
        applied_at integer not null
      )
    `);
  }

  const applied = new Set(
    (db.prepare("select version from schema_migrations order by version").all() as Array<{ version: number }>)
      .map((row) => Number(row.version))
  );
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

export const MIGRATIONS: readonly Migration[] = [
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
  },
  {
    version: 6,
    name: "owned-interaction-controls",
    up(db) {
      db.exec(`
        delete from callback_tokens where user_id is null;
        alter table callback_tokens rename to callback_tokens_v5;
        create table callback_tokens (
          token text primary key,
          action_id text not null,
          resource_kind text not null,
          expected_version integer,
          chat_id integer not null,
          user_id integer not null,
          operation text not null,
          payload_json text not null,
          expires_at integer not null,
          created_at integer not null,
          consumed_at integer,
          claim_id text,
          claimed_at integer
        );
        insert into callback_tokens
          (token, action_id, resource_kind, expected_version, chat_id, user_id, operation,
           payload_json, expires_at, created_at, consumed_at, claim_id, claimed_at)
        select token,
          case
            when operation = 'select-workspace-project' then json_extract(payload_json, '$.path')
            when operation = 'resume-codex-thread' then json_extract(payload_json, '$.threadId')
            when operation = 'select-session-model' then json_extract(payload_json, '$.sessionId')
            when operation in ('select-background-process', 'confirm-background-process') then json_extract(payload_json, '$.processId')
            when operation = 'select-send-thread' then coalesce(json_extract(payload_json, '$.sessionId'), json_extract(payload_json, '$.threadId'))
            when operation in ('legacy-tmux-attach', 'legacy-tmux-probe') then coalesce(json_extract(payload_json, '$.attachmentId'), json_extract(payload_json, '$.target'))
            else action_id
          end,
          case
            when operation = 'select-workspace-project' then 'workspace-project'
            when operation = 'resume-codex-thread' then 'codex-thread'
            when operation = 'select-session-model' then 'session'
            when operation in ('select-background-process', 'confirm-background-process') then 'background-process'
            when operation = 'select-send-thread' and json_extract(payload_json, '$.sessionId') is not null then 'session'
            when operation = 'select-send-thread' then 'codex-thread'
            when operation = 'legacy-tmux-attach' then 'legacy-tmux-target'
            when operation = 'legacy-tmux-probe' then 'legacy-tmux-attachment'
            when operation in ('decision', 'start', 'custom', 'back', 'skip', 'answer') then 'pending-action'
            else 'legacy'
          end,
          case
            when json_type(payload_json, '$.expectedVersion') in ('integer', 'real')
              then cast(json_extract(payload_json, '$.expectedVersion') as integer)
            else null
          end,
          chat_id, user_id, operation,
          payload_json, expires_at, created_at, consumed_at, claim_id, claimed_at
        from callback_tokens_v5;
        drop table callback_tokens_v5;
        create index callback_tokens_cleanup on callback_tokens(expires_at, consumed_at);
        drop table if exists session_grants;

        alter table pending_actions rename to pending_actions_v5;
        create table pending_actions (
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
          status text not null,
          expires_at integer not null,
          created_at integer not null,
          resolved_at integer,
          telegram_chat_id integer,
          telegram_message_id integer,
          failure_reason text
        );
        insert into pending_actions
          (id, kind, session_id, request_id, request_id_type, connection_generation, thread_id,
           turn_id, item_id, title, body, payload_json, status, expires_at, created_at,
           resolved_at, telegram_chat_id, telegram_message_id, failure_reason)
        select id, kind, session_id, request_id, request_id_type, connection_generation, thread_id,
          turn_id, item_id, title, body, payload_json, status, expires_at, created_at,
          resolved_at, telegram_chat_id, telegram_message_id, failure_reason
        from pending_actions_v5;
        drop table pending_actions_v5;
        create index pending_actions_cleanup on pending_actions(status, resolved_at, expires_at);
      `);
    }
  },
  {
    version: 7,
    name: "scrub-terminal-sensitive-data",
    up(db) {
      if (tableExists(db, "event_log")) db.exec("delete from event_log");
      if (tableExists(db, "pending_actions")) {
        db.exec(`
          update pending_actions
          set body = '', payload_json = '{}', failure_reason = null
          where status not in ('pending', 'submitting', 'failed');
        `);
      }
      if (tableExists(db, "callback_tokens") && tableExists(db, "pending_actions")) {
        db.exec(`
          update callback_tokens set payload_json = '{}'
          where action_id in (select id from pending_actions where status not in ('pending', 'submitting', 'failed'));
        `);
      }
      if (tableExists(db, "interaction_drafts") && tableExists(db, "pending_actions")) {
        db.exec(`
          update interaction_drafts set answers_json = '{}'
          where action_id in (select id from pending_actions where status not in ('pending', 'submitting', 'failed'));
        `);
      }
      if (tableExists(db, "notification_outbox")) {
        db.exec(`
          update notification_outbox set last_error = null;
          update notification_outbox set payload_json = '{}' where status = 'sent';
        `);
      }
    }
  },
  {
    version: 8,
    name: "remove-legacy-tmux-fallback",
    up(db) {
      if (tableExists(db, "callback_tokens")) {
        db.exec(`
          delete from callback_tokens
          where operation in ('legacy-tmux-attach', 'legacy-tmux-probe')
             or resource_kind in ('legacy-tmux-target', 'legacy-tmux-attachment');
        `);
      }
      db.exec(`
        drop table if exists legacy_tmux_observations;
        drop table if exists legacy_tmux_attachments;
      `);
    }
  }
];

function migrateLegacySessions(db: Database.Database): void {
  const sessions = db.prepare("select * from sessions order by updated_at desc, id desc").all() as Array<Record<string, unknown>>;
  const runtimeState = new RuntimeStateRepository(db);
  const threadRuntime = new ThreadRuntimeRepository(db);
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
    threadRuntime.reparentLegacySessions(stateIds, canonicalId);
    for (const table of ["pending_actions", "event_log", "transcript_chunks", "session_grants"].filter((name) => tableExists(db, name))) {
      db.prepare(`update ${table} set session_id = ? where session_id in (${marks})`).run(canonicalId, ...ids);
    }
    const active = runtimeState.get<string>("last_active_session_id");
    if (active && ids.includes(active)) runtimeState.set("last_active_session_id", canonicalId);
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

function addColumn(db: Database.Database, table: string, column: string, type: string): void {
  const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(`alter table ${table} add column ${column} ${type}`);
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
