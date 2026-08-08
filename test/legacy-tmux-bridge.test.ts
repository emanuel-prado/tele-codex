import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { LegacyTmuxBridge, type TmuxCommandRunner, type TmuxRunOptions } from "../src/legacy/legacy-tmux-bridge.js";
import { Store } from "../src/store/store.js";

describe("LegacyTmuxBridge", () => {
  it("does not invoke tmux during construction and reports a missing binary only for explicit fallback use", async () => {
    const store = new Store(":memory:");
    let calls = 0;
    const bridge = new LegacyTmuxBridge(config(), store, logger(), async () => {
      calls += 1;
      throw new Error("spawn tmux ENOENT");
    });

    expect(calls).toBe(0);
    await expect(bridge.listPanes()).rejects.toThrow(/legacy tmux fallback failed.*ENOENT/i);
    expect(calls).toBe(1);
    expect(store.listSessions()).toEqual([]);
    store.close();
  });

  it("persists tmux attachments separately and sends only after explicit input confirmation", async () => {
    const store = new Store(":memory:");
    const tmux = fakeTmux("pane preview");
    const bridge = new LegacyTmuxBridge(config(), store, logger(), tmux.run, async () => {});
    const attachment = await bridge.attach("work:1.0", 10);

    expect(store.getSession(attachment.id)).toBeUndefined();
    expect(store.listSessions(true)).toEqual([]);
    expect(bridge.listAttachments(10)[0]).toMatchObject({ target: "work:1.0", chatId: 10, inputStatus: "unknown" });
    expect(bridge.listAttachments(11)).toEqual([]);
    await expect(bridge.send(attachment.id, 11, "cross-chat")).rejects.toThrow(/belongs to another chat/i);
    await expect(bridge.send(attachment.id, 10, "unsafe")).rejects.toThrow(/not verified/i);

    bridge.markReady(attachment.id, 10);
    await expect(bridge.send(attachment.id, 10, "hello")).resolves.toBe("pane preview");
    expect(tmux.commands.some((item) => item.args[0] === "set-buffer" && item.args.includes("hello"))).toBe(true);
    expect(tmux.commands.some((item) => item.args[0] === "paste-buffer" && item.args.includes("work:1.0"))).toBe(true);
    expect(tmux.commands.every((item) => item.options.timeoutMs === 5_000 && item.options.maxBuffer === 128 * 1024)).toBe(true);
    store.close();
  });

  it("lists panes and keeps probe state on the legacy attachment", async () => {
    const store = new Store(":memory:");
    const tmux = fakeTmux("recent output");
    const bridge = new LegacyTmuxBridge(config(), store, logger(), tmux.run, async () => {});

    await expect(bridge.listPanes()).resolves.toEqual([
      expect.objectContaining({ target: "work:1.0", command: "codex", title: "Agent", active: true })
    ]);
    const attachment = await bridge.attach("work:1.0", 10);
    const probe = await bridge.probe(attachment.id, 10, "f12");
    expect(probe).toMatchObject({ sessionId: attachment.id, strategy: "f12", status: "needs-confirmation" });
    expect(store.getLegacyTmuxAttachment(attachment.id)).toMatchObject({
      inputStatus: "needs-confirmation",
      submitStrategy: "f12"
    });
    store.close();
  });

  it("isolates malformed and disappearing panes while listing healthy panes", async () => {
    const store = new Store(":memory:");
    store.upsertLegacyTmuxAttachment({
      id: "tmux_unknown",
      target: "unknown:9.9",
      label: "possibly malformed",
      chatId: 10,
      status: "attached",
      inputStatus: "unknown",
      submitStrategy: "enter"
    });
    store.upsertLegacyTmuxAttachment({
      id: "tmux_gone",
      target: "work:1.1",
      label: "disappearing",
      chatId: 10,
      status: "attached",
      inputStatus: "unknown",
      submitStrategy: "enter"
    });
    const logs: unknown[] = [];
    const run: TmuxCommandRunner = async (_file, args) => {
      if (args[0] === "list-panes") {
        return {
          stdout: [
            "work\t1\t0\tcodex\tHealthy\t1\t%1\t111",
            "malformed pane record",
            "work\t1\t1\tcodex\tGone\t0\t%2\t222"
          ].join("\n")
        };
      }
      if (args[0] === "capture-pane" && args.at(-1) === "work:1.1") {
        throw new Error("can't find pane: work:1.1");
      }
      if (args[0] === "capture-pane") return { stdout: "healthy preview" };
      return { stdout: "" };
    };
    const bridge = new LegacyTmuxBridge(config(), store, { warn(fields: unknown) { logs.push(fields); } } as never, run);

    await expect(bridge.listPanes()).resolves.toEqual([
      expect.objectContaining({ target: "work:1.0", preview: "healthy preview", paneIdentity: "%1:111" })
    ]);
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ boundary: "legacy-tmux.list-panes-row", failureKind: "malformed-output" }),
      expect.objectContaining({ boundary: "legacy-tmux.capture-pane", failureKind: "pane-loss" })
    ]));
    expect(store.getLegacyTmuxAttachment("tmux_unknown")?.status).toBe("attached");
    expect(store.getLegacyTmuxAttachment("tmux_gone")?.status).toBe("stale");
    store.close();
  });

  it("processes only new output across unchanged and overlapping bounded captures", async () => {
    const store = new Store(":memory:");
    const tmux = fakeTmux("old line\nworking");
    const bridge = new LegacyTmuxBridge(config(), store, logger(), tmux.run, async () => {});
    const attachment = await bridge.attach("work:1.0", 10);

    await expect(bridge.capture(attachment.id, 10)).resolves.toMatchObject({ status: "unchanged", observations: [] });
    tmux.state.text = "working\nnew result";
    tmux.state.position += 1;
    const first = await bridge.capture(attachment.id, 10);
    expect(first).toMatchObject({ status: "updated", newOutput: "new result" });
    expect(first.observations).toHaveLength(1);

    tmux.state.text = "new result\nThis operation requires approval. [y/N]";
    tmux.state.position += 1;
    const approval = await bridge.capture(attachment.id, 10);
    expect(approval.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "heuristic-interaction", confidence: "high", reason: expect.any(String) })
    ]));
    await expect(bridge.capture(attachment.id, 10)).resolves.toMatchObject({ status: "unchanged", observations: [] });

    tmux.state.text = "This operation requires approval. [y/N]\ndone";
    tmux.state.position += 1;
    const resolvedScrollback = await bridge.capture(attachment.id, 10);
    expect(resolvedScrollback.newOutput).toBe("done");
    expect(resolvedScrollback.observations.filter((item) => item.kind === "heuristic-interaction")).toEqual([]);

    tmux.state.text = "done\nThis operation requires approval. [y/N]";
    tmux.state.position += 1;
    const repeatedPrompt = await bridge.capture(attachment.id, 10);
    expect(repeatedPrompt.newOutput).toContain("requires approval");
    expect(repeatedPrompt.observations.filter((item) => item.kind === "heuristic-interaction")).toEqual([]);
    expect(store.listLegacyTmuxObservations(attachment.id).filter((item) => item.kind === "heuristic-interaction")).toHaveLength(1);
    expect(store.getTranscript(attachment.id)).toBe("");
    expect(store.recentLogs(attachment.id, 10)).toEqual([]);
    expect(store.listPendingActions(attachment.id)).toEqual([]);
    expect(tmux.commands.filter((item) => item.args[0] === "capture-pane").every((item) => item.args.includes("-200") || item.args.includes("-30"))).toBe(true);
    store.close();
  });

  it("bounds persisted pane captures", async () => {
    const store = new Store(":memory:");
    const tmux = fakeTmux("x".repeat(100 * 1024));
    const bridge = new LegacyTmuxBridge(config(), store, logger(), tmux.run, async () => {});
    const attachment = await bridge.attach("work:1.0", 10);

    expect(Buffer.byteLength(store.getLegacyTmuxAttachment(attachment.id)?.captureTail ?? "", "utf8")).toBeLessThanOrEqual(64 * 1024);
    store.close();
  });

  it("skips ambiguous redraws instead of replaying the pane", async () => {
    const store = new Store(":memory:");
    const tmux = fakeTmux("\u001b[31moriginal screen\u001b[0m   ");
    const bridge = new LegacyTmuxBridge(config(), store, logger(), tmux.run, async () => {});
    const attachment = await bridge.attach("work:1.0", 10);
    tmux.state.text = "original screen";
    await expect(bridge.capture(attachment.id, 10)).resolves.toMatchObject({ status: "unchanged", observations: [] });
    tmux.state.text = "redrawn screen with Approve this command?";

    await expect(bridge.capture(attachment.id, 10)).resolves.toMatchObject({
      status: "uncertain",
      newOutput: "",
      observations: []
    });
    store.close();
  });

  it("marks missing and replaced panes stale", async () => {
    const store = new Store(":memory:");
    const tmux = fakeTmux("output");
    const bridge = new LegacyTmuxBridge(config(), store, logger(), tmux.run, async () => {});
    const replaced = await bridge.attach("work:1.0", 10);
    bridge.markReady(replaced.id, 10);
    tmux.state.identity = "%2:222";
    await expect(bridge.send(replaced.id, 10, "must not leak")).rejects.toThrow(/replaced by a different pane/i);
    expect(tmux.commands.some((item) => item.args[0] === "set-buffer" && item.args.includes("must not leak"))).toBe(false);
    expect(store.getLegacyTmuxAttachment(replaced.id)).toMatchObject({ status: "stale", inputStatus: "stale" });

    tmux.state.identity = "%1:111";
    const missing = await bridge.attach("work:1.0", 10);
    tmux.state.exists = false;
    await expect(bridge.capture(missing.id, 10)).resolves.toMatchObject({ status: "stale" });
    expect(store.getLegacyTmuxAttachment(missing.id)).toMatchObject({ status: "stale", inputStatus: "stale" });
    store.close();
  });

  it("interrupts an external pane with Ctrl-C without killing it or claiming lifecycle ownership", async () => {
    const store = new Store(":memory:");
    const tmux = fakeTmux("running");
    const bridge = new LegacyTmuxBridge(config(), store, logger(), tmux.run, async () => {});
    const attachment = await bridge.attach("work:1.0", 10);
    await bridge.interrupt(attachment.id, 10);

    expect(tmux.commands.some((item) => item.args.join(" ") === "send-keys -t work:1.0 C-c")).toBe(true);
    expect(tmux.commands.some((item) => item.args.includes("kill-pane") || item.args.includes("kill-session"))).toBe(false);
    expect(store.getLegacyTmuxAttachment(attachment.id)?.status).toBe("attached");
    store.close();
  });

  it("keeps an attachment live after a transient interrupt failure and stales it after proven loss", async () => {
    const store = new Store(":memory:");
    const tmux = fakeTmux("running");
    const logs: unknown[] = [];
    const bridge = new LegacyTmuxBridge(config(), store, { warn(fields: unknown) { logs.push(fields); } } as never,
      async (file, args, options) => {
        if (args.join(" ") === "send-keys -t work:1.0 C-c") throw new Error("temporary transport interruption");
        return tmux.run(file, args, options);
      }, async () => {});
    const attachment = await bridge.attach("work:1.0", 10);

    await expect(bridge.interrupt(attachment.id, 10)).rejects.toThrow(/legacy tmux fallback failed at send-keys/i);
    expect(store.getLegacyTmuxAttachment(attachment.id)).toMatchObject({ status: "attached", inputStatus: "unknown" });
    expect(logs).toContainEqual(expect.objectContaining({
      boundary: "legacy-tmux.send-keys",
      failureKind: "transient"
    }));
    expect(JSON.stringify(logs)).not.toContain("temporary transport interruption");

    tmux.state.exists = false;
    await expect(bridge.interrupt(attachment.id, 10)).rejects.toThrow(/target pane is unavailable/i);
    expect(store.getLegacyTmuxAttachment(attachment.id)).toMatchObject({ status: "stale", inputStatus: "stale" });
    store.close();
  });

  it("orders submit fallbacks by distinct key sequence", async () => {
    const store = new Store(":memory:");
    const tmux = fakeTmux("running");
    const bridge = new LegacyTmuxBridge({ tmuxSubmitKey: "return", tmuxPasteSettleMs: 0 }, store, logger(), tmux.run, async () => {});
    const attachment = await bridge.attach("work:1.0", 10);

    await expect(bridge.probe(attachment.id, 10)).resolves.toMatchObject({ strategy: "return" });
    await expect(bridge.tryNextStrategy(attachment.id, 10)).resolves.toMatchObject({ strategy: "f12" });
    await expect(bridge.tryNextStrategy(attachment.id, 10)).resolves.toMatchObject({ strategy: "ctrl-enter" });
    store.close();
  });

  it("does not log tmux input when a command fails", async () => {
    const store = new Store(":memory:");
    const tmux = fakeTmux("output");
    const logs: unknown[] = [];
    const bridge = new LegacyTmuxBridge(config(), store, { warn(fields: unknown) { logs.push(fields); } } as never,
      async (file, args, options) => {
        if (args[0] === "set-buffer") throw new Error(`tmux rejected ${args.join(" ")}`);
        return tmux.run(file, args, options);
      }, async () => {});
    const attachment = await bridge.attach("work:1.0", 10);
    bridge.markReady(attachment.id, 10);

    await expect(bridge.send(attachment.id, 10, "private tmux input")).rejects.toThrow();

    expect(JSON.stringify(logs)).not.toContain("private tmux input");
    store.close();
  });
});

describe("legacy tmux migration", () => {
  it("moves old PTY/tmux rows out of core session storage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tele-codex-tmux-migration-"));
    const path = join(dir, "state.sqlite");
    const db = new Database(path);
    db.exec(`
      create table sessions (
        id text primary key, adapter text not null, label text not null, cwd text,
        codex_thread_id text, connection_generation integer, tmux_target text, status text not null,
        paused integer not null default 0, active_turn_id text, attach_status text,
        submit_strategy text, last_probe text, last_probe_at integer,
        created_at integer not null, updated_at integer not null
      );
    `);
    db.prepare(
      `insert into sessions
       (id, adapter, label, cwd, tmux_target, status, paused, attach_status, submit_strategy, created_at, updated_at)
       values (?, 'pty', ?, ?, ?, 'idle', 0, 'ready', 'enter', ?, ?)`
    ).run("legacy_1", "old tmux", "/repo", "work:1.0", 1, 2);
    db.close();

    const store = new Store(path);
    expect(store.getSession("legacy_1")).toBeUndefined();
    expect(store.listSessions(true)).toEqual([]);
    expect(store.getLegacyTmuxAttachment("legacy_1")).toMatchObject({
      target: "work:1.0",
      label: "old tmux",
      cwd: "/repo",
      chatId: 0,
      inputStatus: "ready"
    });
    store.close();

    const migrated = new Database(path, { readonly: true });
    expect(migrated.prepare("select name from sqlite_master where type = 'table' and name = 'sessions'").get()).toBeUndefined();
    const legacyColumns = migrated.prepare("pragma table_info(legacy_tmux_attachments)").all() as Array<{ name: string }>;
    expect(legacyColumns.map((column) => column.name)).not.toContain("codex_thread_id");
    const coreColumns = migrated.prepare("pragma table_info(codex_threads)").all() as Array<{ name: string }>;
    expect(coreColumns.map((column) => column.name)).not.toContain("tmux_target");
    migrated.close();
  });
});

function config() {
  return { tmuxSubmitKey: "enter", tmuxPasteSettleMs: 0 };
}

function fakeTmux(initialText: string) {
  const state = {
    text: initialText,
    identity: "%1:111",
    position: 20,
    exists: true
  };
  const commands: Array<{ args: string[]; options: TmuxRunOptions }> = [];
  const run: TmuxCommandRunner = async (_file, args, options) => {
    commands.push({ args: [...args], options });
    if (!state.exists && (args[0] === "display-message" || args[0] === "capture-pane")) {
      throw new Error("can't find pane: work:1.0");
    }
    if (args[0] === "list-panes") {
      if (!state.exists) return { stdout: "" };
      const [paneId, panePid] = state.identity.split(":");
      return { stdout: `work\t1\t0\tcodex\tAgent\t1\t${paneId}\t${panePid}\n` };
    }
    if (args[0] === "display-message") {
      const [paneId, panePid] = state.identity.split(":");
      return { stdout: `${paneId}\t${panePid}\t${state.position}\t0\t0\n` };
    }
    if (args[0] === "capture-pane") return { stdout: state.text };
    return { stdout: "" };
  };
  return { state, commands, run };
}

function logger(): never {
  return { warn() {} } as never;
}
