# App-server contract testing

The checked fixture in `contracts/app-server/contract.json` records the Codex CLI version, every app-server method tele-codex calls or handles, and the required fields of critical lifecycle messages. `npm run contract:check` regenerates TypeScript and JSON schemas from the installed experimental app-server API and rejects missing methods or changed required shapes. Use `npm run contract:refresh` only for an intentional Codex upgrade, then review the protocol changes and update `APP_SERVER_CONTRACT_VERSION`.

CI runs `npm run contract:fixture`, which compares the adapter's method registry and reported version with the checked fixture without requiring Codex. The default test suite does not need Codex, Telegram, credentials, or network access. Its lifecycle coverage is split by ownership:

| Scenario | Automated coverage |
| --- | --- |
| Start thread and complete turn | `test/app-server-lifecycle-scenarios.test.ts` |
| Approval through confirmed resolution | `test/app-server-lifecycle-scenarios.test.ts` |
| Disconnect while approval is pending | `test/app-server-lifecycle-scenarios.test.ts` |
| Stale callback/message after reconnect | `test/app-server-lifecycle-scenarios.test.ts`, `test/app-server-connection.test.ts` |
| Repeated same-thread resume | `test/app-server-lifecycle-scenarios.test.ts`, `test/thread-lifecycle.test.ts` |
| Interrupt, detach, and archive | `test/app-server-lifecycle-scenarios.test.ts` |
| Two threads and two chats without leakage | `test/app-server-lifecycle-scenarios.test.ts`, `test/telegram-routing.test.ts` |
| Delivery failure and outbox retry | `test/store-reliability.test.ts` |
| Event-loop failure and supervised shutdown | `test/runtime-supervisor.test.ts` |
| Startup recovery of orphaned interactions | `test/app-server-connection.test.ts`, `test/thread-lifecycle.test.ts` |

Fake app-server failures include an ordered trace with client/server direction and connection generation. The fake can delay ordinary responses, issue approvals or questions, acknowledge resolution, disconnect/reconnect, and emit duplicate, malformed, unsupported, or stale-generation messages.

`npm run test:appserver` additionally checks the installed schema and runs the read-only live contract smoke. Set `TELE_CODEX_APPSERVER_APPROVAL_SMOKE=1` to run the model-backed approval smoke in a temporary workspace; it declines the requested command and archives the temporary thread.
