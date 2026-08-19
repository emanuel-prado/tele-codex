# ADR 0001: App-server-only execution boundary

- Status: Accepted
- Date: 2026-08-19
- Owning issue: #47

## Context

tele-codex previously exposed a best-effort tmux fallback beside the structured Codex app-server integration. The fallback introduced a second identity, lifecycle, persistence model, command surface, health dependency, and heuristic interaction path. It could not provide the same guarantees as an App-server Attachment or Active Turn.

## Decision

App-server is the sole execution adapter. `SessionManager` depends on the mandatory structured `AppServerRuntime` interface, and Telegram commands operate only on Codex Threads, App-server Attachments, and Active Turns.

Schema migration 8 removes terminal-fallback attachments, observations, and cached Interaction Controls after upgrading every supported earlier schema. Old Telegram buttons remain safe: the generic callback handler reports them as unsupported, and `/tmux` is handled as an unknown command.

Any future execution adapter requires a new architecture and security decision covering identity, restart reconciliation, routing, approvals, observability, and failure semantics.

## Consequences

- Runtime startup, health checks, configuration, persistence APIs, and Telegram UX have one execution boundary.
- Terminal parsing and synthetic input are no longer part of the trust boundary.
- Existing fallback state is intentionally discarded during migration; it is not converted into Codex Thread state.
- Historical migrations remain so databases at schema versions 0 through 7 upgrade deterministically.

## Rejected alternative

Keeping the fallback as an optional module was rejected because optional construction still preserved two incompatible execution models and their operational/security surface.
