import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { JsonRpcClient } from "../src/adapters/json-rpc-client.js";

const logger = {
  debug: () => undefined,
  warn: () => undefined
};

describe("JsonRpcClient", () => {
  it("rejects pending stdio requests when app-server exits before responding", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tele-codex-rpc-"));
    const command = join(dir, "fake-codex");
    await writeFile(command, "#!/bin/sh\nexit 7\n");
    await chmod(command, 0o755);

    const client = new JsonRpcClient(logger as never);
    await client.connectStdio(command);

    await expect(client.request("initialize")).rejects.toThrow(/Codex app-server (stdin failed|exited before responding)/);
  });
});
