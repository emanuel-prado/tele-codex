# App-server contract testing

The checked fixture in `contracts/app-server/contract.json` records the Codex CLI version, every app-server method tele-codex calls or handles, and the required fields of critical lifecycle messages. Its `codexVersion` field names the exact tested CLI release. `npm run contract:check` regenerates TypeScript and JSON schemas from the installed experimental app-server API and rejects missing methods or changed required shapes. Use `npm run contract:refresh` only for an intentional Codex upgrade, then review the protocol changes and update `APP_SERVER_CONTRACT_VERSION`.

## Automated stable-release checks

The `Codex release compatibility` GitHub Actions workflow checks for updates every Monday at 13:17 UTC and can also be started with **Run workflow**. It reads all published `@openai/codex` versions, ignores invalid versions and versions with prerelease suffixes, and compares the newest stable version with the checked contract version. It requires no Codex or Telegram credentials. The compatible path uses the repository's existing `RELEASE_PLEASE_TOKEN` only to push its update branch and open the draft pull request; using that automation credential also allows the pull request's normal checks to run.

When a newer stable version exists, the workflow installs that exact package version into a temporary npm prefix and runs the repository contract checker against its generated app-server protocol. The temporary installation is removed after the check.

- A compatible contract is refreshed intentionally and passed through `npm run typecheck`, `npm test`, `npm run build`, and `npm run contract:fixture`. The workflow then creates one draft pull request for that release, or reuses the existing release branch or pull request without overwriting it.
- An incompatible contract leaves the checked fixture untouched. The workflow uploads the checker report and creates one compatibility issue per release containing the old and new versions, the differences, and the workflow-run link. Later runs add a run-specific update to that issue while preserving human edits.
- If the checked version is already current, the workflow records a successful no-update result and makes no repository change.

The workflow serializes runs to avoid races. Registry values are validated as stable semantic versions and passed to child processes as argument-array values, not executable shell text. Its check, pull-request, and issue paths have separate least-privilege permissions.

To recover from an installation, registry, or transient GitHub failure, open the failed run, download the `codex-release-result` artifact when one exists, correct the external failure, and manually rerun the workflow. A failed compatible verification does not publish a pull request. If a compatible release branch was pushed before pull-request creation failed, the next run opens the draft pull request from that existing branch rather than replacing it. Resolve protocol incompatibilities in the linked issue; after adapting the runtime contract, use **Run workflow** again to confirm the release.

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
