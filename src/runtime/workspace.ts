import { readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

export interface WorkspaceProject {
  name: string;
  path: string;
  updatedAt: number;
}

export async function listWorkspaceProjects(root: string, limit = 12): Promise<WorkspaceProject[]> {
  const rootPath = await canonicalPath(root, "root");
  const entries = await readdir(rootPath, { withFileTypes: true }).catch((error: unknown) => {
    throw workspaceAccessError(error, "root");
  });
  const projects = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map(async (entry) => {
        const path = await canonicalPath(resolve(rootPath, entry.name), "project");
        assertInsideWorkspace(rootPath, path);
        const info = await stat(path);
        return { name: entry.name, path, updatedAt: info.mtimeMs };
      })
  );
  return projects
    .sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name))
    .slice(0, limit);
}

export async function resolveWorkspacePath(root: string, input: string): Promise<WorkspaceProject> {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Expected a project name or path.");
  const rootPath = await canonicalPath(root, "root");
  const unresolvedCandidate = isAbsolute(trimmed) ? resolve(trimmed) : resolve(rootPath, trimmed);
  const candidate = await canonicalPath(unresolvedCandidate, "project");
  assertInsideWorkspace(rootPath, candidate);
  const info = await stat(candidate).catch((error: unknown) => {
    throw workspaceAccessError(error, "project");
  });
  if (!info.isDirectory()) throw new Error("Project path must be an existing directory.");
  return {
    name: basename(candidate),
    path: candidate,
    updatedAt: Date.now()
  };
}

export function assertInsideWorkspace(root: string, candidate: string): void {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const rel = relative(rootPath, candidatePath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new Error("Project path must stay inside the configured workspace root.");
}

async function canonicalPath(path: string, kind: "root" | "project"): Promise<string> {
  return realpath(path).catch((error: unknown) => {
    throw workspaceAccessError(error, kind);
  });
}

function workspaceAccessError(error: unknown, kind: "root" | "project"): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (kind === "root") {
    if (code === "ENOENT" || code === "ENOTDIR") {
      return new Error("Workspace root does not exist. Check TELE_CODEX_WORKSPACE_ROOT.");
    }
    if (code === "EACCES" || code === "EPERM") {
      return new Error("Workspace root cannot be accessed. Check its permissions.");
    }
    return new Error("Workspace root could not be resolved safely.");
  }
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new Error("Project path does not exist. Choose an existing directory under the workspace root.");
  }
  if (code === "EACCES" || code === "EPERM") {
    return new Error("Project path cannot be accessed. Check its permissions.");
  }
  return new Error("Project path could not be resolved safely.");
}
