import { readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

export interface WorkspaceProject {
  name: string;
  path: string;
  updatedAt: number;
}

export async function listWorkspaceProjects(root: string, limit = 12): Promise<WorkspaceProject[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const projects = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map(async (entry) => {
        const path = resolve(root, entry.name);
        const info = await stat(path);
        return { name: entry.name, path, updatedAt: info.mtimeMs };
      })
  );
  return projects
    .sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name))
    .slice(0, limit);
}

export function resolveWorkspacePath(root: string, input: string): WorkspaceProject {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Expected a project name or path.");
  const rootPath = resolve(root);
  const candidate = isAbsolute(trimmed) ? resolve(trimmed) : resolve(rootPath, trimmed);
  assertInsideWorkspace(rootPath, candidate);
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
  throw new Error(`Path must stay inside workspace root: ${rootPath}`);
}
