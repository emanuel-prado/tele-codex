# Contributing

Thanks for considering a contribution to `tele-codex`.

## Local Setup

```bash
npm install
cp .env.example .env
npm run build
```

Use a real Telegram bot token only in `.env`. Do not commit local databases, transcripts, logs, or credentials.

## Checks

Run the same checks used by CI:

```bash
npm run typecheck
npm test
npm run build
```

## Architecture Guidelines

- Keep Telegram UX in `src/telegram/`.
- Route session and control operations through `SessionManager`.
- Keep raw Codex app-server JSON-RPC method names inside the app-server adapter.
- Keep app-server as the sole execution adapter; propose any new execution boundary through an architecture and security issue first.
- Add tests around pure parsing, formatting, policy, and protocol-shape helpers when behavior changes.

## Pull Requests

Prefer focused pull requests with:

- A clear summary of user-visible behavior.
- Notes about security implications, especially approval handling.
- Test coverage or a short explanation of what could not be tested locally.
