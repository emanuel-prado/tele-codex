import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function withTemporaryTextExport<T>(
  prefix: string,
  filename: string,
  content: string,
  deliver: (path: string) => Promise<T>
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const path = join(directory, filename);
  try {
    await writeFile(path, content);
    return await deliver(path);
  } finally {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
