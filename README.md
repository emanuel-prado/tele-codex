<p align="center">
  <img src="assets/brand/tele-codex-logo.png" alt="tele-codex logo" width="180">
</p>

# tele-codex

`tele-codex` is a local Telegram companion for Codex CLI. It lets one trusted Telegram user monitor, resume, and steer Codex sessions running on the same machine.

The default path is Codex app-server over JSON-RPC. A PTY/tmux adapter is available as a fallback for sessions that cannot be reached through app-server.

## Features

- Telegram bot over long polling, with no public webhook.
- Telegram user allow-list, with optional chat ID restriction.
- App-server session creation from project folders under `~/Workspace`.
- Previous app-server thread listing and resume.
- Model selection, plan/default mode switching, context compaction, and thread archive controls.
- Approval, question, completion, error, and blocked-state notifications.
- SQLite persistence for sessions, pending actions, event logs, transcripts, and session grants.
- Full transcript export with Telegram-safe message truncation for live output.
- Fallback PTY/tmux attachment with input probing.

## Requirements

- Node.js 22 or newer.
- Codex CLI installed and authenticated on the same machine.
- A Telegram bot token from BotFather.
- Your Telegram numeric user ID.
- `tmux` only if you plan to use the fallback tmux adapter.

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

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TELE_CODEX_BOT_TOKEN` | required | Telegram bot token. |
| `TELE_CODEX_ALLOWED_USER_IDS` | required | Comma-separated Telegram user IDs allowed to control Codex. |
| `TELE_CODEX_ALLOWED_CHAT_IDS` | empty | Optional comma-separated chat IDs. |
| `TELE_CODEX_DB_PATH` | `.tele-codex/tele-codex.db` | SQLite database path. |
| `TELE_CODEX_DEFAULT_ADAPTER` | `appserver` | `appserver` or `pty`. |
| `TELE_CODEX_WORKSPACE_ROOT` | `~/Workspace` | Root used by `/new` project discovery. |
| `TELE_CODEX_CODEX_COMMAND` | `codex` | Codex executable. |
| `TELE_CODEX_APP_SERVER_URL` | unset | Optional remote app-server websocket URL. |
| `TELE_CODEX_PTY_SUBMIT_KEY` | `enter` | Submit strategy for PTY/tmux fallback. |
| `TELE_CODEX_ALLOW_SESSION_GRANTS` | `true` | Enables “approve for session.” |

Manual project paths passed to `/new` must stay inside `TELE_CODEX_WORKSPACE_ROOT`.

## Telegram Commands

Core:

- `/status` shows the active session.
- `/panel` shows a Telegram control panel for common actions.
- `/sessions` lists local bridge sessions with controls.
- `/new` opens a workspace project picker.
- `/new <project-or-path>` starts an app-server session in a workspace folder.
- `/send <text>` forwards slash-prefixed text to Codex.
- Plain text forwards to the active session.

App-server controls:

- `/resume` lists previous app-server threads.
- `/resume <threadId|localSessionId>` resumes a previous app-server thread.
- `/threads` lists previous app-server threads.
- `/model` lists available models.
- `/model <model-id>` changes the active app-server session model for subsequent turns.
- `/models` lists available models.
- `/plan [on|off]` switches between plan/default mode.
- `/mode <plan|default>` switches collaboration mode.
- `/compact` starts context compaction for the active thread.
- `/archive` archives the active app-server thread after confirmation.

Session utilities:

- `/log [n]` shows recent logs.
- `/usage` shows the latest token usage reported by app-server.
- `/transcript` exports the active session transcript.
- `/pause` and `/unpause` toggle Telegram input forwarding.
- `/kill` interrupts the active session after confirmation.

Fallback tmux:

- `/tmux` lists tmux panes and starts an attach probe.
- `/tmux <target>` attaches to a tmux pane directly.
- `/attach tmux <target>` attaches to a tmux pane directly.
- `/testinput` sends a probe and asks you to confirm whether Codex answered.

## Security Model

This is designed for a single trusted user controlling a local machine. Do not expose it as a public webhook or shared bot without revisiting the threat model.

- Unauthorized Telegram users are rejected before command handling.
- If `TELE_CODEX_ALLOWED_CHAT_IDS` is set, both user ID and chat ID must match.
- Approval callbacks include an action ID and nonce.
- Expired or nonce-mismatched approvals are rejected.
- Session-level approval grants can be disabled with:

```bash
TELE_CODEX_ALLOW_SESSION_GRANTS=false
```

Never commit `.env`, bot tokens, app-server tokens, SQLite databases, or transcripts that may contain private code or credentials.

## Development

```bash
npm run typecheck
npm test
npm run build
```

The project is intentionally small:

- `src/telegram/` handles Telegram command and callback UX.
- `src/runtime/` owns session routing and workspace resolution.
- `src/adapters/` contains the app-server and PTY/tmux adapters.
- `src/store/` persists local bridge state.
- `src/security/` enforces Telegram and approval policy.
- `docs/technical-design.md` describes the main seams and risks.

## Adapter Notes

App-server is the primary adapter because it exposes structured JSON-RPC events and controls for approvals, thread resume, model selection, collaboration mode, and compaction.

Token usage is captured from app-server `thread/tokenUsage/updated` notifications. `/usage`, `/status`, and `/panel` show the latest usage snapshot once Codex has reported one for the active thread.

PTY/tmux is fallback-only. Terminal output parsing and submit-key behavior depend on the Codex TUI and the local terminal stack, so tmux attachment remains best-effort.
