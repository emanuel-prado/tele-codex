# Technical Design

## Architecture

`TelegramGateway` handles Bot API polling and command UX. `PendingInteractionManager` owns questions, approvals, permission grants, and MCP forms: opaque callbacks, persisted drafts, validation, and single-submit transitions. `SessionManager` owns active-session routing. `AppServerAdapter` speaks Codex app-server JSON-RPC and maintains the reconnecting transport. Durable Codex threads, live app-server attachments, and active turns are separate records; a thread keeps one stable local ID across detach and resume. Each transport has a persisted, monotonically increasing connection generation, and live attachments plus server-initiated requests are bound to that generation. `PtyAdapter` remains a fallback. `Store` persists threads, legacy sessions, interactions, delivery state, operational snapshots, logs, and transcripts in SQLite.

The adapter seam is intentionally deeper than raw chat forwarding. Core chat/session operations are common to both adapters, while app-server-only controls are exposed as optional adapter capabilities: thread listing/resume, model listing/selection, collaboration mode changes, compaction, and archive. Telegram command handlers call `SessionManager`, not protocol method names directly.

## State

SQLite tables:

- `codex_threads`: durable app-server thread identity and local metadata, unique by Codex thread ID.
- `appserver_attachments`: current attachment status and connection generation for a durable thread.
- `active_turns`: the currently running Codex turn, separate from durable thread and attachment state.
- `sessions`: legacy PTY/tmux and diagnostic records; app-server rows are migrated into the normalized tables.
- `pending_actions`: approval/question requests, their owning app-server generation, and their `pending`, `submitting`, confirmed, orphaned, or retryable-failure state.
- `event_log`: normalized event log for `/log`.
- `transcript_chunks`: full Codex output chunks for `/transcript`.
- `session_grants`: explicit session-level approval records.
- `callback_tokens` and `interaction_drafts`: short Telegram controls and restart-safe wizard state.
- `notification_outbox`: at-least-once high-signal Telegram delivery.
- `session_runtime` and `global_runtime`: plans, diffs, goals, limits, and recovery metadata.
- `action_messages`: Telegram messages associated with pending requests so keyboards can be invalidated.

The bridge can restart and retain thread metadata. Legacy app-server rows are grouped by Codex thread ID; the newest row becomes canonical and transcripts, logs, pending actions, grants, usage, progress, goals, diffs, and the last-active pointer are reparented transactionally. Persisted attachments and turns are not treated as live after restart. App-server threads can be manually resumed through Telegram session controls, and `/resume` can query Codex history directly. tmux sessions can be reattached by target pane through the fallback flow.

`/kill` interrupts only the active turn. `/detach` removes the live attachment, `/archive` archives the durable Codex thread, and `/forget` removes local tele-codex metadata without deleting Codex history. Detached, archived, errored, stopped, and paused records cannot become implicit send targets. `/sessions` shows current or recoverable records; `/sessions all` includes archived and legacy diagnostic rows.

## Notification Strategy

High-signal events for all sessions are committed to the SQLite outbox before delivery:

- approval requests
- questions
- task completion
- errors
- blocked states

Transient delivery failures use capped exponential backoff; repeated failures are visible through `/health` and can be requeued. Transcript streaming remains best-effort, but its buffer is flushed before a durable completion notification. Full output is persisted for `/transcript`.

## Approval Strategy

App-server interactions are answered through typed JSON-RPC responses. Telegram callback data carries only a short random token; the action, decision, intended chat, expiry, and payload stay in SQLite. Claiming an action is transactional, so duplicate or cross-chat callbacks cannot submit it twice. A successful transport write moves an action to `submitting`; only the matching `serverRequest/resolved` notification from the same connection generation marks it resolved. Retryable write failures retain a usable callback control and appear through `/pending`. Secret questions are never collected through Telegram.

## Reconnection

Telegram long polling resumes through Bot API update offsets managed by `grammY`. JSON-RPC requests have bounded waits. Transport messages and close events carry their connection generation, so delayed events from an older child process or socket cannot mutate a newer connection. Transport loss clears only attachments from the lost generation, orphans its unresolved requests, invalidates their Telegram controls, and tells the user to resume the thread and retry the original command. App-server threads are resumed only after explicit Telegram selection. A systemd user service provides restart-on-failure and control-group cleanup. tmux sessions remain non-durable and best-effort.

## Known Risks

- Codex app-server is experimental and may change protocol fields or control method shapes.
- JSON-RPC over stdio is assumed to be newline-delimited; verify against the installed Codex version before relying on it operationally.
- PTY/tmux classification and input submission are fallback-only and heuristic.
- Session-level grants reduce friction but increase blast radius.
