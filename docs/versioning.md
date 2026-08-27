# Versioning and releases

tele-codex uses [Semantic Versioning 2.0.0](https://semver.org/) for repository
versions. `package.json` is the source of truth, and the root package entry in
`package-lock.json` must carry the same version.

## Version meaning

A version has the form `MAJOR.MINOR.PATCH`:

- `MAJOR` changes when an upgrade requires deliberate operator action or
  breaks a documented compatibility contract.
- `MINOR` changes for backward-compatible features and substantial operational
  improvements.
- `PATCH` changes for backward-compatible fixes, security hardening, and
  documentation-only corrections that need a release.

Release Please derives the next version from Conventional Commits. A breaking
change increments `MAJOR`, `feat` increments `MINOR`, and `fix` or `perf`
increments `PATCH`. Other commit types do not trigger a release by themselves,
but are included in the next changelog. A stable `0.x` release means that the
tagged snapshot passed the release gate and is suitable for the supported
single-Controller deployment model. It does not imply a stable public API.

Database schema versions and the checked Codex app-server contract version are
independent compatibility identifiers. They must not be inferred from the
application version.

## Tags

Stable releases use immutable annotated tags named `vMAJOR.MINOR.PATCH`, such
as `v0.1.0`. Prerelease candidates use
`vMAJOR.MINOR.PATCH-rc.NUMBER`, such as `v0.2.0-rc.1`.

Do not create or move a floating `stable` tag. Automation and operators should
pin an exact version tag or commit so that a deployment remains reproducible.
Once published, a version tag is never moved or reused; corrections receive a
new version.

## Branch flow

`develop` is the default integration branch. Work starts from an issue-linked
`agent/<issue-number>-<short-kebab-description>` branch and returns to
`develop` through a squash-merged pull request with a Conventional Commit
title. When a release batch is ready, a maintainer opens a `develop` to
`master` promotion pull request and merges it with a merge commit.

`master` is the stable release branch. Release Please reacts to a promotion by
opening or updating a release pull request against `master`. That pull request
contains the synchronized `package.json`, `package-lock.json`, release
manifest, and `CHANGELOG.md`. After a release, automation opens a `master` to
`develop` synchronization pull request so new issue branches inherit the
released version.

## Release procedure

1. Merge issue pull requests into `develop`. The Conventional Commit titles
   determine the next version and changelog categories.
2. Open and review a manual `develop` to `master` promotion pull request.
3. Merge the promotion with a merge commit. Release Please then creates or
   updates the release pull request against `master`.
4. Confirm that the release pull request updates `package.json`, both root
   version fields in `package-lock.json`, `.release-please-manifest.json`, and
   `CHANGELOG.md` to one version.
5. Run the complete repository gate on both promotion and release pull
   requests:

   ```bash
   npm run typecheck
   npm test
   npm run build
   ```

   Also run `npm run test:appserver` when the installed Codex app-server
   contract or adapter integration changed.
6. Merge the release pull request with a merge commit. Release Please creates
   the immutable `vX.Y.Z` tag and stable GitHub Release from that exact commit;
   this private package is not published to npm.
7. Verify the tag, package metadata, changelog heading, and GitHub Release all
   name the same version. Merge the generated synchronization pull request back
   into `develop` after its checks pass.

Release automation authenticates with the repository-scoped
`RELEASE_PLEASE_TOKEN` secret. Never print, log, or commit that credential.
Record any check that could not be run; never describe an unverified check as
passing.

Urgent fixes follow the same procedure. If a published release must be
withdrawn, document the reason and release a new version rather than changing
the old tag.
