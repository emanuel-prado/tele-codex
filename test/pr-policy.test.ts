import { describe, expect, it } from "vitest";
import { validatePullRequest, type PullRequestContext } from "../scripts/pr-policy.js";

function validate(overrides: Partial<PullRequestContext> = {}): string[] {
  return validatePullRequest({
    base: "develop",
    body: "Refs #70",
    head: "agent/70-develop-release-flow",
    title: "feat(release): adopt automated releases",
    ...overrides
  });
}

describe("pull request policy", () => {
  it("accepts a Conventional Commit issue pull request that references its issue", () => {
    expect(validate()).toEqual([]);
  });

  it("rejects issue branches without their owning issue reference", () => {
    expect(validate({ body: "Refs #69" })).toContain("pull request body must reference owning issue #70");
  });

  it("rejects non-issue branches targeting develop", () => {
    expect(validate({ head: "feature/release-flow" })).toContain(
      "develop only accepts agent/<issue>-<slug> or master branches"
    );
  });

  it("rejects non-Conventional Commit titles", () => {
    expect(validate({ title: "Adopt automated releases" })).toContain(
      "pull request title must use Conventional Commits"
    );
  });

  it("accepts a versioned master-to-develop release synchronization", () => {
    expect(validate({
      body: "",
      head: "master",
      title: "chore(release): sync v0.2.0 to develop"
    })).toEqual([]);
  });

  it("rejects an arbitrary master-to-develop pull request", () => {
    expect(validate({ head: "master", title: "chore: merge master" })).toContain(
      "master-to-develop pull requests must be release synchronization PRs"
    );
  });

  it("accepts develop promotions and Release Please branches into master", () => {
    expect(validate({ base: "master", body: "", head: "develop" })).toEqual([]);
    expect(validate({
      base: "master",
      body: "",
      head: "release-please--branches--master--components--tele-codex",
      title: "chore(master): release 0.2.0"
    })).toEqual([]);
  });

  it("rejects issue branches targeting master directly", () => {
    expect(validate({ base: "master" })).toContain(
      "master only accepts develop promotions or Release Please branches"
    );
  });

  it("rejects unsupported target branches", () => {
    expect(validate({ base: "staging" })).toContain("pull requests must target develop or master");
  });
});
