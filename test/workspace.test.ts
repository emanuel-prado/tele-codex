import { mkdtemp, mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { listWorkspaceProjects, resolveWorkspacePath } from "../src/runtime/workspace.js";

describe("workspace discovery", () => {
  it("lists top-level projects by recent update time", async () => {
    const root = await mkdtemp(join(tmpdir(), "tele-codex-workspace-"));
    const older = join(root, "older");
    const newer = join(root, "newer");
    await mkdir(older);
    await mkdir(newer);
    await mkdir(join(root, ".hidden"));
    await mkdir(join(older, "nested"));

    const oldDate = new Date("2024-01-01T00:00:00.000Z");
    const newDate = new Date("2024-01-02T00:00:00.000Z");
    await utimes(older, oldDate, oldDate);
    await utimes(newer, newDate, newDate);

    const projects = await listWorkspaceProjects(root);

    expect(projects.map((project) => project.name)).toEqual(["newer", "older"]);
  });

  it("resolves normal nesting and the root itself to canonical paths", async () => {
    const parent = await mkdtemp(join(tmpdir(), "tele-codex-workspace-parent-"));
    const realRoot = join(parent, "workspace");
    const rootLink = join(parent, "workspace-link");
    const nested = join(realRoot, "project", "nested");
    await mkdir(nested, { recursive: true });
    await symlink(realRoot, rootLink);

    await expect(resolveWorkspacePath(rootLink, "project/nested")).resolves.toMatchObject({
      path: nested,
      name: "nested"
    });
    await expect(resolveWorkspacePath(rootLink, ".")).resolves.toMatchObject({
      path: realRoot,
      name: "workspace"
    });
  });

  it("rejects lexical paths outside the workspace root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "tele-codex-workspace-parent-"));
    const root = join(parent, "workspace");
    const outside = join(parent, "outside");
    await mkdir(root);
    await mkdir(outside);

    await expect(resolveWorkspacePath(root, "../outside")).rejects.toThrow(/inside the configured workspace root/);
    await expect(resolveWorkspacePath(root, outside)).rejects.toThrow(/inside the configured workspace root/);
  });

  it("rejects direct, intermediate, and final symlink escapes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "tele-codex-workspace-parent-"));
    const root = join(parent, "workspace");
    const outside = join(parent, "outside");
    await mkdir(join(root, "nested"), { recursive: true });
    await mkdir(join(outside, "child"), { recursive: true });
    await symlink(outside, join(root, "direct-link"));
    await symlink(outside, join(root, "intermediate-link"));
    await symlink(join(outside, "child"), join(root, "nested", "final-link"));

    await expect(resolveWorkspacePath(root, "direct-link")).rejects.toThrow(/inside the configured workspace root/);
    await expect(resolveWorkspacePath(root, "intermediate-link/child")).rejects.toThrow(/inside the configured workspace root/);
    await expect(resolveWorkspacePath(root, "nested/final-link")).rejects.toThrow(/inside the configured workspace root/);
  });

  it("reports missing roots and projects without exposing their paths", async () => {
    const parent = await mkdtemp(join(tmpdir(), "tele-codex-workspace-parent-"));
    const root = join(parent, "private-workspace-name");
    await mkdir(root);

    const missingProject = resolveWorkspacePath(root, "private-project-name");
    await expect(missingProject).rejects.toThrow("Project path does not exist. Choose an existing directory under the workspace root.");
    await expect(missingProject).rejects.not.toThrow(/private-project-name|private-workspace-name/);

    const missingRoot = resolveWorkspacePath(join(parent, "private-missing-root"), ".");
    await expect(missingRoot).rejects.toThrow("Workspace root does not exist. Check TELE_CODEX_WORKSPACE_ROOT.");
    await expect(missingRoot).rejects.not.toThrow(/private-missing-root/);
  });

  it("rejects files with an actionable path-free error", async () => {
    const root = await mkdtemp(join(tmpdir(), "tele-codex-workspace-"));
    await writeFile(join(root, "private-file-name"), "not a directory");

    const result = resolveWorkspacePath(root, "private-file-name");
    await expect(result).rejects.toThrow("Project path must be an existing directory.");
    await expect(result).rejects.not.toThrow(/private-file-name/);
  });
});
