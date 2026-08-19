# tele-codex

tele-codex gives one local operator a controlled Telegram surface for working
with Codex threads. Telegram is a remote-control and delivery boundary; Codex
app-server is the sole execution adapter.

## Language

### Controller

The sole Telegram user authorized to operate a tele-codex instance.

Avoid: allowed user, bot user, operator list.

> “The callback belongs to the Controller who opened the interaction.”

### Telegram Chat

An authorized Telegram delivery and routing scope. A chat is not an identity
and does not grant control independently of the Controller.

Avoid: user session, controller identity.

> “Deliver the recovery card to the authorized Telegram Chat.”

### Codex Thread

The durable Codex conversation identity. It can outlive a process connection,
Telegram message, or local attachment.

Avoid: Telegram session, app-server session, pane.

> “The Codex Thread is durable, but it is not automatically attached after a restart.”

### App-server Attachment

A live subscription and control association between a Codex Thread and one
initialized app-server connection generation.

Avoid: persisted session, resumed thread.

> “Interrupt requires a current App-server Attachment.”

### Active Turn

The currently running unit of Codex work within a Codex Thread.

Avoid: session, process.

> “The Active Turn became idle after the interruption completed.”

### Interaction Control

A short-lived opaque Telegram action bound to its Controller, Telegram Chat,
resource state, intended operation, and expiry.

Avoid: raw callback payload, permanent button.

> “Claim the Interaction Control before applying the destructive action.”

### Session-level Approval

A native Codex decision that extends an approval for the current Codex session.
It is an explicit opt-in capability, not a locally inferred grant.

Avoid: remembered Telegram approval, local session grant.

> “Session-level Approval is disabled unless the Controller opts in.”

### Transcript

Durable agent-output history intended for the Controller to read or export.

Avoid: event log, diagnostic record.

> “The agent message belongs in the Transcript, not the Event Log.”

### Event Log

Normalized operational diagnostics used to understand lifecycle and delivery
failures. It must not contain transcript content, secrets, approval answers, or
user-specific workspace paths.

Avoid: transcript archive, raw RPC dump.

> “Record a sanitized connection failure in the Event Log.”
