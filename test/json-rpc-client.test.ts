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

    await expect(client.request("initialize")).rejects.toMatchObject({
      name: "AppServerFailure",
      kind: "transport_loss",
      method: "initialize"
    });
  });

  it("bounds requests when app-server stays silent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tele-codex-rpc-timeout-"));
    const command = join(dir, "fake-codex");
    await writeFile(command, "#!/bin/sh\nsleep 5\n");
    await chmod(command, 0o755);

    const client = new JsonRpcClient(logger as never, 20);
    await client.connectStdio(command);
    await expect(client.request("initialize")).rejects.toMatchObject({
      name: "AppServerFailure",
      kind: "timeout",
      method: "initialize"
    });
    client.close();
  });

  it("preserves remote method, code, and data without putting secret data in the message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tele-codex-rpc-remote-"));
    const command = join(dir, "fake-codex");
    await writeFile(command, "#!/bin/sh\nread line\nprintf '%s\\n' '{\"id\":1,\"error\":{\"code\":-32042,\"message\":\"rejected\",\"data\":{\"token\":\"super-secret\"}}}'\nsleep 1\n");
    await chmod(command, 0o755);
    const client = new JsonRpcClient(logger as never);
    await client.connectStdio(command);

    const error = await client.request("thread/start", { token: "request-secret" }).catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      name: "AppServerFailure",
      kind: "remote_rejection",
      method: "thread/start",
      code: -32042,
      data: { token: "super-secret" }
    });
    expect(String(error)).not.toContain("super-secret");
    expect(String(error)).not.toContain("request-secret");
    expect(JSON.stringify(error)).not.toContain("super-secret");
    client.close();
  });

  it("distinguishes missing connections and connection-generation changes", async () => {
    const client = new JsonRpcClient(logger as never);
    expect(() => client.notify("initialized")).toThrow(expect.objectContaining({
      name: "AppServerFailure",
      kind: "missing_connection",
      method: "initialized"
    }));

    const dir = await mkdtemp(join(tmpdir(), "tele-codex-rpc-generation-"));
    const command = join(dir, "fake-codex");
    await writeFile(command, "#!/bin/sh\nsleep 1\n");
    await chmod(command, 0o755);
    await client.connectStdio(command, 2);
    expect(() => client.notify("initialized", undefined, 1)).toThrow(expect.objectContaining({
      name: "AppServerFailure",
      kind: "generation_changed",
      method: "initialized"
    }));
    client.close();
  });

  it("reports malformed app-server traffic as a protocol defect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tele-codex-rpc-protocol-"));
    const command = join(dir, "fake-codex");
    await writeFile(command, "#!/bin/sh\nprintf 'not-json\\n'\nsleep 1\n");
    await chmod(command, 0o755);
    const client = new JsonRpcClient(logger as never);
    const failure = new Promise<unknown>((resolve) => client.once("failure", resolve));

    await client.connectStdio(command, 1);

    await expect(failure).resolves.toMatchObject({
      name: "AppServerFailure",
      kind: "protocol_defect"
    });
    client.close();
  });
});
