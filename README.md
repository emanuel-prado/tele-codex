<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/tele-codex-wordmark-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/brand/tele-codex-wordmark-light.png">
    <img src="assets/brand/tele-codex-wordmark-light.png" alt="tele-codex" width="720">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/emanuel-prado/tele-codex/actions/workflows/ci.yml"><img src="https://github.com/emanuel-prado/tele-codex/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="docs/app-server-contract-testing.md"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Femanuel-prado%2Ftele-codex%2Fmaster%2Fcontracts%2Fapp-server%2Fcontract.json&amp;query=%24.codexVersion&amp;label=tested%20Codex&amp;color=0284c7" alt="Tested Codex CLI version"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Femanuel-prado%2Ftele-codex%2Fmaster%2Fpackage.json&amp;query=%24.engines.node&amp;label=Node.js&amp;color=339933&amp;logo=nodedotjs&amp;logoColor=white" alt="Required Node.js version"></a>
</p>

`tele-codex` is a local Telegram companion for Codex CLI. It lets one trusted Controller monitor, resume, and steer Codex Threads on the same machine. Codex app-server over JSON-RPC is the only execution runtime.

Read the **[Controller handbook](docs/user-guide.md)** for setup, everyday use, security, recovery, configuration, and the full command reference.

## Features

- Explicit routing to new, active, detached, and previous Codex Threads.
- Telegram controls for models, modes, compaction, goals, processes, approvals, and questions.
- Durable notifications, Transcripts, Event Logs, health reporting, and restart recovery.
- A supervised Linux user service for unattended local operation.
- A single-Controller security model with opaque, short-lived Interaction Controls.

## Five-minute quickstart

You need Node.js 22 or newer, an installed and signed-in [Codex CLI](https://developers.openai.com/codex/cli), and a Telegram bot token from BotFather.

```bash
cp .env.example .env
npm install
npm run build
```

Put the bot token in `.env`. Send the bot a private message, then discover your numeric IDs locally:

```bash
node dist/cli.js telegram-ids
```

Set `TELE_CODEX_ALLOWED_USER_IDS` to the reported sender ID. Check the setup and start in the foreground:

```bash
node dist/cli.js doctor
npm start
```

In Telegram, run `/new`, choose a project, then use `/send` to choose the Codex Thread for your next message. See [First run](docs/user-guide.md#first-run) for the complete, safe procedure.

## Security

Telegram input can control your local machine. Use a private bot for one trusted Controller. Never commit `.env`, tokens, databases, Transcripts, private code, or approval answers. Local app-server stdio and the Controller's private Telegram Chat are the supported defaults.

## Contributing

Run the repository gate before publishing changes:

```bash
npm run typecheck
npm test
npm run build
```

- [Controller handbook](docs/user-guide.md)
- [Technical design](docs/technical-design.md)
- [App-server contract testing](docs/app-server-contract-testing.md)
- [Versioning and releases](docs/versioning.md)
- [Changelog](CHANGELOG.md)
- [Domain language](CONTEXT.md)
