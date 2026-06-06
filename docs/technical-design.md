# Technical Design

## Architecture

`TelegramGateway` handles Bot API polling, command parsing, inline callbacks, workspace project selection, and message delivery. `SessionManager` owns the active session and routes user input, approval actions, and app-server control commands to a `CodexAdapter`. `AppServerAdapter` speaks Codex app-server JSON-RPC and is the primary adapter. `PtyAdapter` launches a managed PTY or attaches to tmux as a fallback. `Store` persists sessions, pending actions, logs, transcripts, and grants in SQLite.

The adapter seam is intentionally deeper than raw chat forwarding. Core chat/session operations are common to both adapters, while app-server-only controls are exposed as optional adapter capabilities: thread listing/resume, model listing/selection, collaboration mode changes, compaction, and archive. Telegram command handlers call `SessionManager`, not protocol method names directly.

## State

SQLite tables:

- `sessions`: local bridge sessions with adapter-specific identifiers.
- `pending_actions`: approval/question requests waiting for Telegram input.
- `event_log`: normalized event log for `/log`.
- `transcript_chunks`: full Codex output chunks for `/transcript`.
- `session_grants`: explicit session-level approval records.

The bridge can restart and retain session metadata. App-server sessions can be manually resumed from stored thread IDs through Telegram session controls, and `/resume` can query previous app-server threads directly. tmux sessions can be reattached by target pane through the fallback flow.

## Notification Strategy

Forward high-signal events for all sessions:

- approval requests
- questions
- task completion
- errors
- blocked states

Transcript output is streamed only for the active session, buffered into readable Telegram messages, and middle-truncated when necessary. Full output is persisted for `/transcript`. PTY output is summarized and stored for `/log`; tmux attachment remains best-effort.

## Approval Strategy

App-server approvals are answered through JSON-RPC responses to server-initiated requests. PTY approvals are answered by injecting conservative `y` or `n` input. Callback data carries an action ID, nonce, and decision. Expired or mismatched nonces are rejected.

## Reconnection

Telegram long polling resumes through Bot API update offsets managed by `grammY`. App-server sessions are listed after restart and resumed only after explicit Telegram selection. `/resume` and `/threads` query app-server thread metadata directly; stored local sessions remain available through `/sessions`. tmux sessions should be reattached by target through `/tmux`. Managed PTY sessions are not durable across process death.

## Known Risks

- Codex app-server is experimental and may change protocol fields or control method shapes.
- JSON-RPC over stdio is assumed to be newline-delimited; verify against the installed Codex version before relying on it operationally.
- PTY/tmux classification and input submission are fallback-only and heuristic.
- Session-level grants reduce friction but increase blast radius.
