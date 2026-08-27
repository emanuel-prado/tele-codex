# Issue tracker

The canonical issue tracker is GitHub Issues in
`emanuel-prado/tele-codex`.

## Conventions

- Create independently grabbable issues with one coherent outcome.
- Use `## What to build`, `## Acceptance criteria`, and `## Blocked by`
  sections for implementation issues.
- Express dependencies with GitHub issue references. Use `None` when an issue
  has no blockers.
- Apply one triage-state label and any relevant type label.
- When work starts, use the issue's Development control to create a linked
  `agent/<issue-number>-<short-kebab-description>` branch from the default
  `develop` branch.
- Open issue pull requests against `develop` as drafts. Reference the owning
  issue and use `Closes #...` only when that pull request fully satisfies it.
- Use a Conventional Commit pull-request title. Squash issue pull requests into
  `develop` so that title becomes the integration commit.
- Only manual `develop` to `master` promotion pull requests and Release Please
  pull requests target `master`. Stable releases come from immutable tags, not
  an arbitrary branch head.
