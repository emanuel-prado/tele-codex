# Repository Agent Rules

These instructions apply to the entire repository. Repository-specific security and reliability rules below take precedence over the shared delivery contract.

## Shared Delivery Contract

- Never implement directly on `main`, `master`, or another default branch.
- Start each implementation slice from an up-to-date default branch and create `agent/<issue-or-slice>-<short-kebab-description>`.
- Keep one coherent implementation slice per branch, worktree, commit series, and pull request.
- Use a separate git worktree for concurrent or unfinished agent sessions. Never reuse a dirty worktree or overwrite unrelated user work.
- Use Conventional Commits: `<type>(optional-scope): <imperative summary>`.
- Run the narrowest relevant checks while developing, then the complete documented verification suite before publishing.
- Report exactly which checks ran, their results, and anything skipped. Never claim an unrun check passed.
- Open pull requests as drafts by default. Link the owning issue and use `Closes #...` only when the pull request fully satisfies it.
- Do not expand scope, perform drive-by refactors, merge, enable auto-merge, mark ready for review, force-push, rewrite published history, resolve review threads, or dismiss feedback unless explicitly asked.

## Security and Trust Boundary

- Treat Telegram input as remote control of a local machine. Preserve the user and optional chat allow-lists before command dispatch.
- Never log or commit bot tokens, app-server credentials, `.env`, SQLite databases, transcripts, private code, approval answers, or user-specific workspace paths.
- Keep callback payloads opaque and validate ownership, expiry, resolution state, session identity, and intended chat before applying an action.
- Do not broaden the threat model to public webhooks, shared bots, or multi-user control without an explicit architecture and security issue.
- Preserve workspace-root containment for user-supplied paths and avoid shell interpolation where argument arrays or structured APIs are available.

## Session and Adapter Architecture

- App-server is the primary adapter. PTY/tmux is fallback-only and must not leak terminal-specific assumptions into app-server session management.
- Keep Telegram UX, session routing, adapters, persistence, and security policy behind explicit boundaries.
- A local bridge session, Codex thread, Telegram conversation, app-server connection, and tmux pane are distinct identities. Do not infer that one exists merely because another is persisted.
- Persist durable state only when it can be reconciled after restart. Stale or unreachable sessions must be identifiable, prunable, and excluded from active-session UX.
- Never route plain text or commands to an implicit stale session. Session selection and `/send` behavior must have an explicit, testable routing contract.

## Reliability and Observability

- Telegram commands must never fail silently. Convert expected failures into actionable user-visible messages and record structured diagnostic context without secrets.
- Distinguish transient connection loss, missing app-server connection, stale persisted session, timeout, invalid command state, and internal defects.
- Background tasks must have supervised lifecycles. Capture rejected promises, process exits, polling failures, adapter disconnects, and shutdown errors.
- Restart behavior must be explicit for sessions, pending approvals/questions, outbox deliveries, and recovery cards. Do not advertise automatic thread resume unless it is actually implemented and verified.
- Use idempotency or transactional guards for approval resolution, command callbacks, delivery retries, and state transitions that may be repeated.

## Verification

Before publishing code changes, run the relevant subset and then the complete repository gate:

```bash
npm run typecheck
npm test
npm run build
```

Run `npm run test:appserver` when the installed Codex app-server contract or adapter integration changes.

Changes to routing, session lifecycle, persistence, approvals, retries, or Telegram commands require tests for happy paths, stale state, missing connections, timeouts, restarts, duplicate callbacks, and user-visible error reporting. Use fakes for Telegram, app-server, tmux, clocks, and process boundaries in the default test suite.

Update `docs/technical-design.md` when adapter boundaries, session identity, persistence ownership, security policy, or unattended-operation guarantees change.

## Agent skills

Repository workflow context for planning and issue-management skills lives in:

- `docs/agents/issue-tracker.md` for the canonical tracker and issue conventions.
- `docs/agents/triage-labels.md` for the repository's triage state vocabulary.
- `docs/agents/domain.md` for domain-document locations and ownership.

Read those files before using `to-issues`, `to-prd`, `triage`, `diagnose`,
`tdd`, `improve-codebase-architecture`, or `zoom-out` in this repository.
