# Security Policy

`tele-codex` is a local control bridge for a trusted user. It can forward prompts, approve actions, and steer Codex sessions on your machine. Treat it as sensitive infrastructure.

## Supported Use

- Run it locally.
- Use Telegram long polling.
- Restrict access with `TELE_CODEX_ALLOWED_USER_IDS`.
- Add `TELE_CODEX_ALLOWED_CHAT_IDS` when possible.

Do not expose it as a public webhook or shared multi-user bot without a separate security review.

## Sensitive Data

Never publish:

- `.env` files.
- Telegram bot tokens.
- App-server tokens.
- SQLite state under `.tele-codex/`.
- Transcript exports containing private code, credentials, or prompts.

## Reporting Issues

For now, open a GitHub security advisory or a private issue/discussion in the repository where this project is hosted. Include:

- The affected version or commit.
- Whether the issue requires Telegram access, filesystem access, or app-server access.
- Minimal reproduction steps.

Avoid posting live tokens, private transcripts, or private repository content.
