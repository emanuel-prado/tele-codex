import { mkdtemp, mkdir, utimes } from "node:fs/promises";
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

  it("resolves relative project names inside the workspace root", () => {
    const project = resolveWorkspacePath("/home/me/Workspace", "tele-codex");

    expect(project.path).toBe("/home/me/Workspace/tele-codex");
    expect(project.name).toBe("tele-codex");
  });

  it("rejects paths outside the workspace root", () => {
    expect(() => resolveWorkspacePath("/home/me/Workspace", "../Secrets")).toThrow(/inside workspace root/);
    expect(() => resolveWorkspacePath("/home/me/Workspace", "/tmp/project")).toThrow(/inside workspace root/);
  });
});
