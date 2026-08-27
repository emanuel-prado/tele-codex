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

Before `1.0.0`, the project is still establishing its compatibility contract.
Breaking changes may therefore increment `MINOR`; release notes must call them
out and provide migration instructions. A stable `0.x` release means that the
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

## Release procedure

1. Start a release branch from the latest default branch.
2. Choose the next version from the user-visible and operational impact since
   the previous stable tag.
3. Update `package.json` and `package-lock.json` together. Summarize behavior
   changes, migrations, security considerations, and known limitations in the
   pull request or release notes.
4. Run the complete repository gate:

   ```bash
   npm run typecheck
   npm test
   npm run build
   ```

   Also run `npm run test:appserver` when the installed Codex app-server
   contract or adapter integration changed.
5. Merge the reviewed release change into the default branch.
6. Create the annotated tag on the merge commit and verify that its version
   matches `package.json`:

   ```bash
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin vX.Y.Z
   ```

7. Publish release notes from that exact tag. Record any check that could not be
   run; never describe an unverified check as passing.

Urgent fixes follow the same procedure. If a published release must be
withdrawn, document the reason and release a new version rather than changing
the old tag.
