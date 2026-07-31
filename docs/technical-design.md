# Technical Design

## Architecture

`TelegramGateway` handles Bot API polling and command UX. `TelegramRouting` owns explicit destination selection: persisted thread-picker controls, one-shot compose state, reply associations, and opt-in per-chat/user sticky routes. `PendingInteractionManager` owns questions, approvals, permission grants, and MCP forms: opaque callbacks, persisted drafts, validation, and single-submit transitions. `SessionManager` is the app-server-only Codex thread façade; its required `AppServerRuntime` interface exposes structured capabilities without adapter dispatch or optional-method casts. `AppServerAdapter` implements that interface over JSON-RPC and maintains the reconnecting transport, thread registry, turn coordination, interaction coordination, and event publication. Durable Codex threads, live app-server attachments, and active turns are separate records; a thread keeps one stable local ID across detach and resume. Each transport has a persisted, monotonically increasing connection generation, and live attachments plus server-initiated requests are bound to that generation. `LegacyTmuxBridge` is a separate best-effort module invoked only by explicit `/tmux` commands. `Store` persists core threads, separate legacy tmux attachments, routing and interaction state, delivery state, operational snapshots, logs, and transcripts in SQLite.

`RuntimeSupervisor` is the sole lifecycle owner. It starts the SQLite cleanup owner, eager app-server transport, adapter event forwarder, Telegram polling, Telegram event ingestion, delivery outbox worker, and action sweeper; waits for every critical loop; and stops them in reverse order exactly once. Rejection or unexpected completion of any critical loop records a durable fatal correlation, marks health failed, completes cleanup, and rejects the top-level wait so the process exits nonzero. Signal-driven stop uses the same idempotent path and exits cleanly.

`RuntimeHealth` owns the in-memory live snapshot and persists only the last fatal diagnostic. Overall health requires a running supervisor, connected app-server transport, and every critical subsystem in its running state. Reconnecting is degraded and a failed/dead control path is unhealthy. Telegram middleware records authorized update activity, the outbox records delivery successes and failures, and app-server telemetry includes transport, child PID when available, connection generation, reconnect attempt, and last message time. Command/callback failures return a correlation ID without exposing internal details; callbacks receive a prompt acknowledgement while slow work continues.

App-server and tmux do not share an interface: they have different identity, lifecycle, interaction, and failure semantics. The core interface is mandatory and app-server-specific. The legacy bridge exposes pane listing, attachment, probing, sending, and interrupt operations against `LegacyTmuxAttachment`; it does not emit structured Codex events or create app-server pending actions from parsed terminal text. A missing tmux binary therefore affects only an explicit fallback command, never normal construction or startup.

## State

SQLite tables:

- `codex_threads`: durable app-server thread identity and local metadata, unique by Codex thread ID.
- `appserver_attachments`: current attachment status and connection generation for a durable thread.
- `active_turns`: the currently running Codex turn, separate from durable thread and attachment state.
- `sessions`: temporary compatibility migration source; old app-server and PTY rows are moved out and the mixed-schema table is then removed.
- `legacy_tmux_attachments`: tmux target, owning chat, heuristic input state, submit strategy, and probe metadata; it cannot contain Codex thread, turn, or connection-generation state.
- `pending_actions`: approval/question requests, their owning app-server generation, and their `pending`, `submitting`, confirmed, orphaned, or retryable-failure state.
- `event_log`: normalized event log for `/log`.
- `transcript_chunks`: full Codex output chunks for `/transcript`.
- `session_grants`: explicit session-level approval records.
- `callback_tokens` and `interaction_drafts`: short chat/user-bound Telegram controls and restart-safe wizard state.
- `routing_composes` and `sticky_routes`: restart-safe one-shot compose selections and explicit per-chat/user sticky routes.
- `session_chats` and `telegram_thread_messages`: thread delivery audiences and bot-message associations used for reply routing.
- `notification_outbox`: at-least-once high-signal Telegram delivery.
- `session_runtime` and `global_runtime`: plans, diffs, goals, limits, and recovery metadata.
- `action_messages`: Telegram messages associated with pending requests so keyboards can be invalidated.

The bridge can restart and retain thread metadata. Legacy app-server rows are grouped by Codex thread ID; the newest row becomes canonical and transcripts, logs, pending actions, grants, usage, progress, goals, diffs, and the last-active pointer are reparented transactionally. Old PTY rows with tmux targets migrate to `legacy_tmux_attachments`; managed PTY rows are discarded because managed PTY mode no longer exists. Persisted app-server attachments and turns are not treated as live after restart. App-server threads can be manually resumed through Telegram session controls, and `/resume` can query Codex history directly. Legacy tmux attachments stay outside core session listing, routing, approvals, transcripts, and recovery cards.

`/kill` interrupts only the active turn. `/detach` removes the live attachment, `/archive` archives the durable Codex thread, and `/forget` removes local tele-codex metadata without deleting Codex history. No record is an implicit send target. `/send` creates a five-minute, one-message compose route; its opaque picker tokens are scoped to chat, user, thread identity, expiry, and the thread version observed when the picker opened. Direct `/send`, replies to associated agent messages, and an explicit `/use` sticky route are the other accepted text-routing paths. Detached app-server threads selected explicitly are resumed before composing; archived, removed, stale-version, stopped, and paused targets fail visibly. `/sessions` and all routing surfaces contain Codex threads only. Legacy tmux uses `/tmux` controls whose opaque callback tokens are scoped to chat, user, operation, attachment, expiry, and expected attachment version.

## Notification Strategy

High-signal events for all sessions are committed to the SQLite outbox before delivery:

- approval requests
- questions
- task completion
- errors
- blocked states

Transient delivery failures use capped exponential backoff; repeated failures are visible through `/health` and can be requeued. Once a Telegram chat routes input to a thread, subsequent agent output and interactions for that thread are scoped to its associated chat set instead of broadcast as process-global active-session output. Streamed agent messages retain their Telegram message-to-thread association so a reply returns to the originating thread. Transcript streaming remains best-effort, but its buffer is flushed before a durable completion notification. Full output is persisted for `/transcript`.

## Approval Strategy

App-server interactions are answered through typed JSON-RPC responses. Telegram callback data carries only a short random token; the action, decision, intended chat, expiry, and payload stay in SQLite. Claiming an action is transactional, so duplicate or cross-chat callbacks cannot submit it twice. A successful transport write moves an action to `submitting`; only the matching `serverRequest/resolved` notification from the same connection generation marks it resolved. Retryable write failures retain a usable callback control and appear through `/pending`. Secret questions are never collected through Telegram.

## Reconnection

Telegram long polling resumes through Bot API update offsets managed by `grammY`. JSON-RPC requests have bounded waits. Transport messages and close events carry their connection generation, so delayed events from an older child process or socket cannot mutate a newer connection. Transport loss clears only attachments from the lost generation, orphans its unresolved requests, invalidates their Telegram controls, and tells the user to resume the thread and retry the original command. Reconnect uses capped exponential delay and a bounded attempt budget; recovery resets the budget, while exhaustion fails the supervised transport so systemd can restart the complete runtime. App-server threads are resumed only after explicit Telegram selection. The user service provides restart-on-failure and control-group cleanup; `service update` builds before restart and requires a stable active PID afterward. Legacy tmux attachments persist separately but remain heuristic and best-effort.

## Known Risks

- Codex app-server is experimental and may change protocol fields or control method shapes.
- JSON-RPC over stdio is assumed to be newline-delimited; verify against the installed Codex version before relying on it operationally.
- Legacy tmux capture and input submission are heuristic and require local verification.
- Session-level grants reduce friction but increase blast radius.
