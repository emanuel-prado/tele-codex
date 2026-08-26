# Controller handbook

This handbook is for the technical self-hoster who runs tele-codex for one trusted Controller. It takes you from creating a private Telegram bot to running tele-codex unattended on Linux.

Telegram is a remote-control boundary for your local machine. Keep the default design: one Controller, one private Telegram Chat, and a local Codex app-server process over stdio.

## Before you start

You need Linux or macOS, Node.js 22 or newer, a local project under the configured workspace root, and a private Telegram account. The unattended service instructions require Linux with systemd.

Do not put real tokens, private code, Transcripts, or approval answers in screenshots, issue reports, shell history, or version control.

## Install and sign in to Codex

Use OpenAI's current [Codex CLI installation guide](https://developers.openai.com/codex/cli). On macOS or Linux, the official standalone installer is:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Run Codex and follow the browser sign-in flow:

```bash
codex
```

OpenAI also documents [Codex sign-in and authentication](https://developers.openai.com/codex/auth). Check the local sign-in state with:

```bash
codex login status
```

tele-codex uses Codex app-server, whose contract can change. Later, `doctor` will check the installed CLI against the version tested by this repository.

## Create a Telegram bot safely

1. Open the verified `@BotFather` chat in Telegram.
2. Send `/newbot` and follow BotFather's prompts.
3. Copy the token directly into the local `.env` file. Do not send it to another bot or person.
4. Do not add the bot to a group for the initial setup.
5. Open a private chat with the new bot and send a short message such as `hello`.

Treat the token like a password. If it is exposed, revoke it with BotFather, create a fresh token, and update `.env` before you restart tele-codex.

## Install tele-codex

From the repository root:

```bash
cp .env.example .env
npm install
npm run build
```

Set the token in `.env` but leave the example file unchanged:

```dotenv
TELE_CODEX_BOT_TOKEN=replace-this-with-the-real-token
TELE_CODEX_ALLOWED_USER_IDS=123456789
```

The example Controller ID is not your authorization setting. Discover the correct ID and replace it before you start tele-codex.

## Discover the Controller and chat IDs

The local discovery command calls Telegram's first-party `getUpdates` API. It requires only `TELE_CODEX_BOT_TOKEN`. It does not start tele-codex, create a database, or connect to Codex. Its output contains only deduplicated sender ID, chat ID, and chat type values, newest first. It does not print the token, names, usernames, timestamps, update IDs, or message content.

Stop tele-codex and any other bot poller first. After sending the bot a private message, run:

```bash
node dist/cli.js telegram-ids
```

For another environment file:

```bash
node dist/cli.js telegram-ids --env-file ./config/tele-codex.env
```

Example output:

```text
sender_id      chat_id        chat_type
123456789      123456789      private
```

Copy `sender_id` to `TELE_CODEX_ALLOWED_USER_IDS`. For the default private-chat setup, leave `TELE_CODEX_ALLOWED_CHAT_IDS` empty. If no row appears, send the bot another message and run the command again. A conflict means a poller or webhook is already reading updates; stop it before retrying.

Do not use a third-party identity bot. It adds an unnecessary party to the trust boundary.

## Configure and check tele-codex

For the default local setup, review these values:

```dotenv
TELE_CODEX_BOT_TOKEN=replace-this-with-the-real-token
TELE_CODEX_ALLOWED_USER_IDS=123456789
TELE_CODEX_ALLOWED_CHAT_IDS=
TELE_CODEX_CODEX_COMMAND=codex
TELE_CODEX_WORKSPACE_ROOT=~/Workspace
TELE_CODEX_APP_SERVER_URL=
TELE_CODEX_APP_SERVER_TOKEN=
```

Run the local checks before starting the bot:

```bash
node dist/cli.js doctor
```

`doctor` can report a malformed or incomplete environment file without creating the database. Correct every failed check. It checks the configured Codex executable and the tested app-server contract as well as local configuration.

### Configuration reference

| Setting | Default | What it controls |
| --- | --- | --- |
| `TELE_CODEX_BOT_TOKEN` | Required | BotFather token. Keep it secret. |
| `TELE_CODEX_ALLOWED_USER_IDS` | Required | The one numeric Controller ID. The plural name remains for compatibility, but exactly one ID is accepted. |
| `TELE_CODEX_ALLOWED_CHAT_IDS` | Empty | Allowed Telegram Chat IDs. Empty accepts only the Controller's private chat. A non-empty list replaces that default. List both the private chat ID and any group ID if you need both. |
| `TELE_CODEX_DB_PATH` | `.tele-codex/tele-codex.db` | SQLite database path. It may contain sensitive local state. |
| `TELE_CODEX_LOG_LEVEL` | `info` | Structured operational log level. |
| `TELE_CODEX_APPROVAL_TIMEOUT_MS` | `900000` | Lifetime of approval and question Interaction Controls, in milliseconds. |
| `TELE_CODEX_RPC_TIMEOUT_MS` | `30000` | Maximum wait for an app-server JSON-RPC response, in milliseconds. |
| `TELE_CODEX_APP_SERVER_MAX_RECONNECT_ATTEMPTS` | `8` | Failed reconnect attempts before the supervised process exits for systemd to restart it. |
| `TELE_CODEX_RATE_LIMIT_WARN_PERCENT` | `80` | First account-limit warning threshold. |
| `TELE_CODEX_TRANSCRIPT_RETENTION_DAYS` | Unset | Deletes finalised Transcript chunks older than this many days during maintenance. Unset keeps them indefinitely. |
| `TELE_CODEX_ALLOW_SESSION_GRANTS` | `false` | Shows native Codex “approve for session” choices. Enable only when the larger approval scope is acceptable. |
| `TELE_CODEX_CODEX_COMMAND` | `codex` | Codex executable or absolute executable path. The service installer resolves and pins it. |
| `TELE_CODEX_WORKSPACE_ROOT` | `~/Workspace` | Containment root for projects opened through `/new`. |
| `TELE_CODEX_APP_SERVER_URL` | Unset | Advanced: remote app-server WebSocket URL instead of local stdio. tele-codex does not provision or secure that endpoint. |
| `TELE_CODEX_APP_SERVER_TOKEN` | Unset | Advanced: bearer token sent to the configured remote WebSocket. Keep it blank for local stdio. |
| `TELE_CODEX_ENV_FILE` | `.env` | Environment-file path used when `--env-file` is absent. |
| `--env-file PATH` | Unset | CLI option that selects an environment file for the current command and takes priority over `TELE_CODEX_ENV_FILE`. |

Manual paths passed to `/new` must remain inside `TELE_CODEX_WORKSPACE_ROOT` after filesystem links are resolved.

### Advanced Telegram groups

Groups broaden who can see agent output, questions, and approval prompts. The Controller ID is always checked, but other group members can see the chat. Telegram bot chats are not end-to-end encrypted.

If `TELE_CODEX_ALLOWED_CHAT_IDS` is non-empty, it replaces the private-chat default. To use a group and retain the private chat, list both chat IDs. Review BotFather privacy settings and the group's membership before use. The single-Controller model does not make a shared group a multi-user control surface.

### Advanced remote app-server

`TELE_CODEX_APP_SERVER_URL` and `TELE_CODEX_APP_SERVER_TOKEN` are references for an existing WebSocket endpoint. tele-codex does not create the endpoint, configure TLS, distribute credentials, or claim that it is safe for internet exposure. Keep both settings blank to use the supported local stdio path. If you operate a remote endpoint, protect its transport and token outside tele-codex and reassess the trust boundary.

## First run

Start tele-codex in the foreground so you can see startup failures:

```bash
npm start
```

Then, in the authorized private Telegram Chat:

1. Send `/health` and confirm that the runtime and app-server are healthy.
2. Send `/new` and choose a project under the workspace root.
3. Send `/sessions` and note the new Codex Thread alias.
4. Send `/send`, choose that thread, and send a small first request when prompted. You can also use `/send <thread-alias> <message>`.
5. Wait for the completion notification, then use `/transcript` if you need the full agent output.

Creating or selecting a Codex Thread does not make plain text an implicit send target. `/send`, a reply to associated agent output, or an explicit `/use` route chooses the destination.

Stop the foreground process with `Ctrl-C` after this check.

## Run unattended with systemd

The user service is supported on Linux systems that run systemd. Build first, then install it with an absolute environment-file choice:

```bash
npm run build
node dist/cli.js service install --env-file "$PWD/.env"
node dist/cli.js service status
```

The installer validates and pins the Codex executable, enables the service, and starts it. Follow any reported `loginctl enable-linger` instruction if the user manager must run after logout and start at boot.

Update the checked-out code, then let the service manager build and restart safely:

```bash
node dist/cli.js service update
node dist/cli.js service status
```

Follow logs without printing the environment file:

```bash
journalctl --user -u tele-codex.service -f
```

Remove the service when you no longer need unattended operation:

```bash
node dist/cli.js service uninstall
```

An update validates the build and service configuration before restart. A failed validation or build leaves the installed unit and running service unchanged.

## Know the identities and records

| Term | Practical meaning |
| --- | --- |
| Controller | The sole Telegram user allowed to operate this tele-codex instance. |
| Telegram Chat | An authorized delivery and routing scope. It is not a user identity. |
| Codex Thread | The durable Codex conversation. It can outlive the process and local attachment. |
| App-server Attachment | The live control link between one Codex Thread and the current app-server connection. Persisted metadata does not prove that this link is live. |
| Active Turn | The unit of Codex work currently running in a Codex Thread. |
| Interaction Control | A short-lived, opaque Telegram action bound to its Controller, chat, purpose, resource state, and expiry. |
| Transcript | Durable agent output for the Controller to read or export. It can contain private code. |
| Event Log | Sanitized operational diagnostics. It excludes prompts, agent output, answers, secrets, and user-specific workspace paths. |

## Everyday workflows

### Start or resume work

- Use `/new` to choose a contained project and create a Codex Thread.
- Use `/resume`, `/resume last`, or `/threads` to find Codex history. Selecting a thread creates a current App-server Attachment; it does not start an Active Turn.
- Use `/sessions` for local current and recoverable threads. `/sessions all` adds archived diagnostic entries.

### Route messages deliberately

- Use `/send` for a five-minute, one-message route to a selected thread.
- Reply to a tele-codex agent message to route back to the Codex Thread that produced it.
- Use `/use <thread>` for an explicit sticky route in the current Controller/chat scope. Use `/use off` to remove it.
- Plain text without one of these routes is refused. tele-codex never guesses from the last active thread.

### Handle approvals and questions

Interaction Controls carry opaque tokens and expire. Read the displayed request, then use its buttons. Duplicate, stale, expired, or cross-chat actions are rejected. Retryable submission failures remain visible under `/pending`. Secret answers are refused because Telegram bot chats are not end-to-end encrypted.

### Tune a thread

- Use `/model` or `/models` to inspect models and `/model <id>` to change the active thread's model for later turns.
- Use `/plan on`, `/plan off`, or `/mode <plan|default>` to change collaboration mode.
- Use `/compact` to ask Codex to compact the current context.
- Use `/goal start <objective>` to start a durable goal and a turn; `/goal pause`, `/goal resume`, and `/goal clear` manage its metadata.
- Use `/processes` to inspect and safely stop background terminals associated with the thread.

### Observe and recover

- Use `/status`, `/panel`, and `/health` for session and runtime state.
- Use `/pending` for unresolved questions and approvals.
- Use `/retrydelivery` to requeue failed durable notifications.
- Use `/progress`, `/diff`, `/usage`, and `/limits` for turn and account detail.
- Use `/log` for sanitized Event Log entries and `/transcript` for full agent output. Protect Transcript exports as private code.
- Use `/pause` and `/unpause` to stop or resume Telegram input forwarding.

## Choose the right lifecycle action

| Command | What it does | What survives | Confirmation and next step |
| --- | --- | --- | --- |
| `/kill` | Interrupts the proven Active Turn through its current App-server Attachment. | The Codex Thread, local metadata, Transcript, and attachment remain. | Requires confirmation. A disconnected or stale attachment cannot prove an interrupt. Start another turn explicitly. |
| `/detach` | Removes the live App-server Attachment and active local pointer. | The Codex Thread, Codex history, and local metadata remain recoverable. | Immediate. Use `/resume` or explicit thread selection before more work. |
| `/archive` | Archives the durable Codex Thread through app-server and marks local metadata archived. | Codex history remains subject to Codex availability; local archived metadata remains. | Requires confirmation. Use `/resume` and select it from Codex history to restore it if available. |
| `/forget` | Deletes local tele-codex metadata, including local routing, actions, logs, and Transcripts. It does not delete Codex history. | Codex history remains outside tele-codex. | Requires confirmation. Use `/resume` from Codex history if you later need it. |

## Restart recovery

A process restart invalidates persisted App-server Attachments and Active Turns because neither proves a live connection after restart. tele-codex does not automatically resume a Codex Thread, replay an approval or answer, or route plain text to the previously active thread.

If startup finds a prior Active Turn or unresolved interaction, it creates one durable, idempotent recovery notification with no prompt, answer, Transcript, or workspace path. The previous outcome is unknown. Choose a thread explicitly with `/resume`, `/sessions`, or `/send`, inspect its current state, and repeat only the operation you still intend.

Routine starts and clean restarts do not send a generic recovery card. Durable notifications may be delivered more than once, so treat them as notices, not proof that an action ran twice.

## Failure playbook

| Symptom | Check | Safe action |
| --- | --- | --- |
| The bot is silent | Run `service status`, then inspect the user-service logs and `/health` if Telegram still responds. Check that the Controller and Telegram Chat IDs match policy. | Correct the reported local fault. Do not weaken the allow-list or paste the bot token into a chat. |
| Configuration is invalid | Run `node dist/cli.js doctor --env-file PATH`. | Correct only the named setting. `doctor` does not create the database when configuration is invalid. |
| Foreground startup fails | Read the sanitized terminal error and run `doctor`. | Fix the executable, environment file, filesystem permission, or contract mismatch before retrying. Do not post the environment file. |
| Service install or startup fails | Run `node dist/cli.js service status` and inspect `journalctl --user -u tele-codex.service`. | Follow the reported executable, environment-file, or linger guidance. Keep the foreground setup working first. |
| Service update fails | Read the update error and service status. | Fix the checkout or build. The prior unit and running service stay unchanged when pre-restart validation fails. |
| App-server disconnects | Use `/health` to inspect transport state and reconnect attempts. | Wait for reconnection, then explicitly `/resume` the Codex Thread. Reconnection alone does not restore an attachment or Active Turn. |
| A restart recovery card appears | Treat the prior Active Turn outcome as unknown. | Select the thread explicitly, inspect its state and Transcript, then repeat only the work still needed. Do not assume automatic resume or interaction replay. |
| A button says stale, expired, or already resolved | Check `/pending` and the current thread state. | Open a fresh control or ask Codex again. Never reuse callback data or assume an old approval applied. |
| Durable delivery failed | Check `/health` and Telegram connectivity. | Run `/retrydelivery`. At-least-once delivery can repeat a notice; callback ownership and transactional state prevent the notice alone from repeating an action. |
| A message went to the wrong thread or was refused | Check `/sessions`, the replied-to bot message, and `/use` state. | Run `/use off`, then use `/send` or reply to output from the intended thread. Do not rely on the process-global active session. |
| ID discovery reports no updates | Confirm that you messaged the new bot and that tele-codex is stopped. | Send another private message, then rerun `telegram-ids`. |
| ID discovery reports a conflict | Another poller or webhook owns `getUpdates`. | Stop that poller or remove the webhook, then retry. Do not run discovery alongside the bot. |

## Telegram command reference

The table has one row for each root command registered with Telegram. Optional arguments are shown in the purpose column so the root command remains unambiguous.

| Command | Purpose |
| --- | --- |
| `/status` | Show the active session. |
| `/panel` | Show the session control panel. |
| `/sessions` | List local current and recoverable threads; add `all` for archived diagnostics. |
| `/new` | Choose a workspace project or add a contained project path. |
| `/resume` | List and resume previous Codex Threads; accepts `last`, a thread ID, or a local session ID. |
| `/threads` | List previous Codex Threads. |
| `/model` | List models or change the active thread model by ID. |
| `/models` | List available models. |
| `/plan` | Switch plan mode on or off. |
| `/mode` | Switch collaboration mode to `plan` or `default`. |
| `/compact` | Start context compaction for the active thread. |
| `/archive` | Archive the active Codex Thread after confirmation. |
| `/detach` | Remove the current App-server Attachment. |
| `/forget` | Delete one thread's local tele-codex metadata after confirmation. |
| `/send` | Choose a one-message destination or send a message to a named thread. |
| `/use` | Set an explicit sticky route for this Controller and chat; `off` removes it. |
| `/attach` | Attach a Codex Thread by app-server thread ID. |
| `/log` | Show recent sanitized Event Log entries; accepts a count. |
| `/usage` | Show the active thread's latest token usage. |
| `/pending` | Show unresolved Codex questions and approvals. |
| `/health` | Show supervised runtime, app-server, Telegram, and delivery health. |
| `/retrydelivery` | Requeue failed high-signal notifications. |
| `/search` | Search previous Codex Threads by term. |
| `/limits` | Show current Codex account limits. |
| `/progress` | Show the Active Turn plan. |
| `/diff` | Export the latest turn diff. |
| `/goal` | Start, pause, resume, clear, or inspect the active thread goal. |
| `/processes` | Show and safely stop background terminals. |
| `/doctor` | Run local setup health checks. |
| `/transcript` | Export the active session Transcript. |
| `/pause` | Pause Telegram input forwarding. |
| `/unpause` | Resume Telegram input forwarding. |
| `/kill` | Interrupt the Active Turn after confirmation. |
| `/help` | Show help from the running bot. |
