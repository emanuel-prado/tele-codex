import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { LegacyTmuxBridge, type TmuxCommandRunner } from "../src/legacy/legacy-tmux-bridge.js";
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
    const commands: string[][] = [];
    const run: TmuxCommandRunner = async (_file, args) => {
      commands.push(args);
      return { stdout: args[0] === "capture-pane" ? "pane preview" : "" };
    };
    const bridge = new LegacyTmuxBridge(config(), store, logger(), run, async () => {});
    const attachment = await bridge.attach("work:1.0", 10);

    expect(store.getSession(attachment.id)).toBeUndefined();
    expect(store.listSessions(true)).toEqual([]);
    expect(bridge.listAttachments(10)[0]).toMatchObject({ target: "work:1.0", chatId: 10, inputStatus: "unknown" });
    expect(bridge.listAttachments(11)).toEqual([]);
    await expect(bridge.send(attachment.id, 11, "cross-chat")).rejects.toThrow(/belongs to another chat/i);
    await expect(bridge.send(attachment.id, 10, "unsafe")).rejects.toThrow(/not verified/i);

    bridge.markReady(attachment.id, 10);
    await expect(bridge.send(attachment.id, 10, "hello")).resolves.toBe("pane preview");
    expect(commands.some((args) => args[0] === "set-buffer" && args.includes("hello"))).toBe(true);
    expect(commands.some((args) => args[0] === "paste-buffer" && args.includes("work:1.0"))).toBe(true);
    store.close();
  });

  it("lists panes and keeps probe state on the legacy attachment", async () => {
    const store = new Store(":memory:");
    const run: TmuxCommandRunner = async (_file, args) => {
      if (args[0] === "list-panes") return { stdout: "work\t1\t0\tcodex\tAgent\t1\n" };
      return { stdout: "recent output" };
    };
    const bridge = new LegacyTmuxBridge(config(), store, logger(), run, async () => {});

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

function logger(): never {
  return { warn() {} } as never;
}
