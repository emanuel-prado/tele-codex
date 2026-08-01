<p align="center">
  <img src="assets/brand/tele-codex-logo.png" alt="tele-codex logo" width="180">
</p>

# tele-codex

`tele-codex` is a local Telegram companion for Codex CLI. It lets one trusted Telegram user monitor, resume, and steer Codex sessions running on the same machine.

Codex app-server over JSON-RPC is the product runtime. A separate, explicit tmux bridge remains available as a legacy best-effort fallback; it is not a Codex thread adapter.

## Features

- Telegram bot over long polling, with no public webhook.
- Telegram user allow-list, with optional chat ID restriction.
- App-server session creation from project folders under `~/Workspace`.
- Previous Codex session listing and resume across workspaces.
- Model selection, plan/default mode switching, context compaction, and thread archive controls.
- Approval, question, completion, error, and blocked-state notifications.
- Sequential multi-question and MCP form completion from Telegram.
- Durable high-signal notification delivery with retry and restart recovery.
- Goals, account limits, turn plans/diffs, thread search, and background-process controls.
- SQLite persistence for sessions, pending actions, event logs, transcripts, and session grants.
- Full transcript export with Telegram-safe message truncation for live output.
- Explicit legacy tmux attachment with heuristic input probing.

## Requirements

- Node.js 22 or newer.
- Codex CLI installed and authenticated on the same machine.
- A Telegram bot token from BotFather.
- Your Telegram numeric user ID.
- `tmux` only if you plan to use the optional legacy fallback.

## Setup

```bash
cp .env.example .env
npm install
npm run build
```

Set at least:

```bash
TELE_CODEX_BOT_TOKEN=...
TELE_CODEX_ALLOWED_USER_IDS=123456789
```

Then run:

```bash
npm run dev
```

For a production-ish local run:

```bash
npm run build
npm start
```

To check local setup without starting the Telegram bot:

```bash
npm run build
node dist/cli.js doctor
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TELE_CODEX_BOT_TOKEN` | required | Telegram bot token. |
| `TELE_CODEX_ALLOWED_USER_IDS` | required | Exactly one numeric Telegram user ID: the Controller. The plural environment name is retained for compatibility. |
| `TELE_CODEX_ALLOWED_CHAT_IDS` | empty | Optional comma-separated chat IDs. When empty, only the Controller's private chat is accepted. |
| `TELE_CODEX_DB_PATH` | `.tele-codex/tele-codex.db` | SQLite database path. |
| `TELE_CODEX_LOG_LEVEL` | `info` | Structured operational log level. |
| `TELE_CODEX_APPROVAL_TIMEOUT_MS` | `900000` | Expiry for approval and question interactions. |
| `TELE_CODEX_WORKSPACE_ROOT` | `~/Workspace` | Root used by `/new` project discovery. |
| `TELE_CODEX_CODEX_COMMAND` | `codex` | Codex executable. |
| `TELE_CODEX_APP_SERVER_URL` | unset | Optional remote app-server websocket URL. |
| `TELE_CODEX_TMUX_SUBMIT_KEY` | `enter` | Submit strategy for the legacy tmux fallback. |
| `TELE_CODEX_TMUX_PASTE_SETTLE_MS` | `250` | Delay between tmux paste and submit key. |
| `TELE_CODEX_ALLOW_SESSION_GRANTS` | `false` | Enables native Codex “approve for session” decisions. Opt in only when needed. |
| `TELE_CODEX_RPC_TIMEOUT_MS` | `30000` | Maximum wait for an app-server JSON-RPC response. |
| `TELE_CODEX_APP_SERVER_MAX_RECONNECT_ATTEMPTS` | `8` | Failed reconnect attempts before the supervised runtime exits for systemd restart. |
| `TELE_CODEX_RATE_LIMIT_WARN_PERCENT` | `80` | First account-limit warning threshold. |

Manual project paths passed to `/new` must stay inside `TELE_CODEX_WORKSPACE_ROOT`.

`doctor` is safe to run with a missing or malformed `.env`: it reports the
invalid fields and skips dependent runtime checks. It does not create the
database or its parent directory. Correct the reported configuration and rerun
`doctor` before starting the bot.

## Telegram Commands

Core:

- `/status` shows the active session.
- `/panel` shows a Telegram control panel for common actions.
- `/sessions` lists current and recoverable Codex threads with controls; `/sessions all` also includes archived Codex threads.
- `/new` opens a workspace project picker.
- `/new <project-or-path>` starts an app-server session in a workspace folder.
- `/send` opens a recent/recoverable thread picker; the next message is sent once to the selected thread.
- `/send <thread-alias-or-id> <message>` sends directly to one thread.
- Replying to a tele-codex agent message routes the reply to the thread that produced it.
- `/use <thread-alias-or-id>` enables explicit sticky routing for that chat and user; `/use off` disables it.
- `/attach appserver <threadId>` attaches a specific Codex thread. Use `/tmux` for the separate legacy fallback.
- Other plain text is not forwarded and explains how to choose a destination.

App-server controls:

- `/resume` lists recent interactive Codex sessions across all workspaces.
- `/resume last` resumes the most recently updated Codex session.
- `/resume <threadId|localSessionId>` resumes a previous Codex session directly.
- `/threads` lists previous Codex sessions.
- `/model` lists available models.
- `/model <model-id>` changes the active app-server session model for subsequent turns.
- `/models` lists available models.
- `/plan [on|off]` switches between plan/default mode.
- `/mode <plan|default>` switches collaboration mode.
- `/compact` starts context compaction for the active thread.
- `/archive` archives the active durable Codex thread after confirmation.
- `/detach` removes the live app-server attachment while keeping the thread recoverable.
- `/forget <sessionId>` removes local tele-codex metadata without deleting Codex history.

Session utilities:

- `/log [n]` shows recent logs.
- `/usage` shows the latest token usage reported by app-server.
- `/doctor` runs local setup health checks.
- `/health` shows overall lifecycle health, every critical worker, app-server transport/PID/generation/reconnect state, Telegram activity, delivery results, and the last fatal correlation ID.
- `/retrydelivery` requeues failed high-signal notifications.
- `/pending` lists unresolved questions and approvals across sessions.
- `/search <term>` searches previous Codex sessions.
- `/limits` shows current account limits.
- `/progress` shows the latest turn plan; `/diff` exports the latest turn diff.
- `/goal start <objective>` starts a goal and one Codex turn; `/goal pause|resume|clear` controls goal metadata.
- `/processes` lists and safely terminates background terminals.
- `/transcript` exports the active session transcript.
- `/pause` and `/unpause` toggle Telegram input forwarding.
- `/kill` interrupts the active turn after confirmation; it does not delete or detach the durable thread.
- `/help` lists the commands supported by the running bot. Unknown commands return this guidance instead of failing silently.

Legacy tmux fallback:

- `/tmux` lists panes with chat/user-scoped opaque attach controls.
- `/tmux attach <target>` attaches a pane directly; `/tmux <target>` is shorthand.
- `/tmux list` lists this chat's separately persisted legacy attachments.
- `/tmux test <attachmentId>` sends a heuristic probe and asks you to verify the pane locally.
- `/tmux send <attachmentId> <text>` sends only after the attachment input was explicitly confirmed.
- `/tmux capture <attachmentId>` inspects only newly observed bounded pane output. Heuristic interaction warnings never create normal Approve/Deny actions.
- `/tmux interrupt <attachmentId>` sends Ctrl-C to the externally managed pane; it does not kill or take ownership of the pane/process.

## Security Model

This is designed for a single trusted user controlling a local machine. Do not expose it as a public webhook or shared bot without revisiting the threat model.

- The single configured Controller is checked before command handling.
- With no chat allow-list, only the Controller's private chat is accepted. If `TELE_CODEX_ALLOWED_CHAT_IDS` is set, both the Controller ID and chat ID must match.
- Approval and thread-picker callbacks contain short opaque tokens; action details, intended chat/user, target, expiry, and expected resource version remain in SQLite.
- Expired, cross-chat, duplicate, and already-resolved interactions are rejected transactionally.
- Agent output is delivered only to chats associated with its thread, and bot message-to-thread associations make reply routing explicit.
- Session-level approvals are disabled by default. Enable them explicitly with:

```bash
TELE_CODEX_ALLOW_SESSION_GRANTS=true
```

Never commit `.env`, bot tokens, app-server tokens, SQLite databases, or transcripts that may contain private code or credentials.

## Development

```bash
npm run typecheck
npm test
npm run build
# optional: verify the installed Codex app-server contract and generated schema fingerprints
npm run test:appserver

# after intentionally upgrading Codex, refresh and review the checked contract
npm run contract:refresh
```

The project is intentionally small:

- `src/telegram/` handles Telegram command/callback UX and explicit per-chat thread routing.
- `src/runtime/` owns session lifecycle and workspace resolution.
- `src/adapters/` contains the structured app-server implementation.
- `src/legacy/` contains the separate best-effort tmux bridge.
- `src/store/` persists local bridge state.
- `src/security/` enforces Telegram and approval policy.
- `docs/technical-design.md` describes the main seams and risks.

## Runtime Notes

App-server is the only Codex runtime because it exposes structured JSON-RPC events and controls for approvals, thread resume, model selection, collaboration mode, and compaction. Core startup, routing, health, sessions, approvals, and transcripts never construct or inspect tmux state.

Token usage is captured from app-server `thread/tokenUsage/updated` notifications. `/usage`, `/status`, and `/panel` show the latest usage snapshot once Codex has reported one for the active thread.

Legacy tmux is fallback-only. It has separate attachment identity, persistence, observations, and Telegram commands. Captures are bounded, track pane identity plus a durable last-seen boundary, and process only overlapping/new output; ambiguous redraws are skipped. Terminal interaction detection requires explicit markers, carries confidence/reason metadata, and only produces a warning to inspect the local pane. It never becomes an app-server approval, question, transcript, or log.

## Unattended Linux Operation

Build first, then install the user service from the compiled CLI:

```bash
npm run build
node dist/cli.js service install --env-file "$PWD/.env"
node dist/cli.js service status
node dist/cli.js service update
```

The installer writes `~/.config/systemd/user/tele-codex.service`, enables it immediately, restarts it after failures, and keeps Codex child processes in the same systemd control group. `service update` builds first, restarts only after a successful build, and verifies that the restarted unit remains active with a stable PID. If lingering is disabled, follow the reported `loginctl enable-linger` instruction so the user manager survives logout and starts at boot.

Useful operations:

```bash
journalctl --user -u tele-codex.service -f
node dist/cli.js service uninstall
```

The unattended guarantee applies to structured app-server sessions. App-server connectivity, Telegram polling, event forwarding, outbox delivery, and interaction expiry are supervised. Unexpected loop exit records a correlation ID, runs exactly-once cleanup, and exits nonzero so systemd can restart the process. High-signal notifications are persisted and delivered at least once while the host, Telegram, and Codex are reachable. Threads are deliberately not resumed automatically after a process or host restart; Telegram sends a durable recovery card requiring explicit selection. Secret question answers are refused because Telegram bot chats are not end-to-end encrypted.
