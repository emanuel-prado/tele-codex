# Domain documentation

This repository uses a single domain context.

- `CONTEXT.md` is the canonical glossary and defines the shared domain language.
- `docs/technical-design.md` owns current architecture, lifecycle, persistence,
  security-policy, and unattended-operation guarantees.
- `docs/adr/` is reserved for durable architecture decisions when a decision
  needs explicit alternatives, rationale, and consequences. Do not create an
  ADR merely to restate current implementation work.

When a change introduces or materially changes a domain term, update
`CONTEXT.md`. When it changes a boundary or guarantee, update
`docs/technical-design.md` in the same implementation slice.
