# Technical Design

## Architecture

`TelegramGateway` handles Bot API polling and command UX. `PendingInteractionManager` owns questions, approvals, permission grants, and MCP forms: opaque callbacks, persisted drafts, validation, and single-submit transitions. `SessionManager` owns active-session routing. `AppServerAdapter` speaks Codex app-server JSON-RPC and maintains the reconnecting transport. Each app-server transport has a persisted, monotonically increasing connection generation; live thread attachments and server-initiated requests are bound to that generation. `PtyAdapter` remains a fallback. `Store` persists sessions, interactions, delivery state, operational snapshots, logs, and transcripts in SQLite.

The adapter seam is intentionally deeper than raw chat forwarding. Core chat/session operations are common to both adapters, while app-server-only controls are exposed as optional adapter capabilities: thread listing/resume, model listing/selection, collaboration mode changes, compaction, and archive. Telegram command handlers call `SessionManager`, not protocol method names directly.

## State

SQLite tables:

- `sessions`: local bridge sessions with adapter-specific identifiers and the generation of any live app-server attachment.
- `pending_actions`: approval/question requests, their owning app-server generation, and their `pending`, `submitting`, confirmed, orphaned, or retryable-failure state.
- `event_log`: normalized event log for `/log`.
- `transcript_chunks`: full Codex output chunks for `/transcript`.
- `session_grants`: explicit session-level approval records.
- `callback_tokens` and `interaction_drafts`: short Telegram controls and restart-safe wizard state.
- `notification_outbox`: at-least-once high-signal Telegram delivery.
- `session_runtime` and `global_runtime`: plans, diffs, goals, limits, and recovery metadata.
- `action_messages`: Telegram messages associated with pending requests so keyboards can be invalidated.

The bridge can restart and retain session metadata. App-server sessions can be manually resumed from stored thread IDs through Telegram session controls, and `/resume` can query previous app-server threads directly. tmux sessions can be reattached by target pane through the fallback flow.

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
