import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/store/store.js";
import type { PendingAction } from "../src/types/events.js";

describe("Codex thread persistence", () => {
  it("migrates duplicate legacy sessions to the newest stable thread identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tele-codex-thread-migration-"));
    const path = join(dir, "state.db");
    const initial = new Store(path);
    initial.appendTranscript("session_old", "old transcript");
    initial.appendTranscript("session_new", "new transcript");
    initial.appendLog({ sessionId: "session_old", type: "old", severity: "info", text: "old log" });
    initial.appendLog({ sessionId: "session_new", type: "new", severity: "info", text: "new log" });
    initial.setDiff("session_old", "preserved diff");
    initial.setProgress("session_new", { plan: [{ step: "new", status: "completed" }], updatedAt: 20 });
    initial.setGoal("session_old", { objective: "preserve", status: "active", tokensUsed: 5, timeUsedSeconds: 2, updatedAt: 10 });
    initial.setTokenUsage("session_old", usage(30, 300));
    initial.setTokenUsage("session_new", usage(20, 200));
    initial.putPendingAction(action("session_old"));
    initial.setRuntimeValue("last_active_session_id", "session_old");
    initial.close();

    const db = new Database(path);
    insertLegacySession(db, "session_old", "thread_1", "Old", 10, "stopped");
    insertLegacySession(db, "session_new", "thread_1", "New", 20, "idle");
    db.close();

    const store = new Store(path);

    expect(store.listSessions()).toHaveLength(1);
    expect(store.getSession("session_new")).toMatchObject({
      id: "session_new",
      codexThreadId: "thread_1",
      label: "New",
      status: "detached"
    });
    expect(store.getSession("session_old")).toBeUndefined();
    expect(store.getTranscript("session_new")).toContain("old transcript");
    expect(store.getTranscript("session_new")).toContain("new transcript");
    expect(store.recentLogs("session_new", 10)).toHaveLength(2);
    expect(store.getPendingAction("action_1")?.sessionId).toBe("session_new");
    expect(store.getTokenUsage("session_new")?.total.totalTokens).toBe(300);
    expect(store.getProgress("session_new")?.plan[0]?.step).toBe("new");
    expect(store.getDiff("session_new")).toBe("preserved diff");
    expect(store.getGoal("session_new")?.objective).toBe("preserve");
    expect(store.getRuntimeValue("last_active_session_id")).toBe("session_new");
    store.close();
  });

  it("upserts one local record for repeated resumes of the same Codex thread", () => {
    const store = new Store(":memory:");
    const first = store.upsertSession({ id: "first", adapter: "appserver", label: "First", codexThreadId: "thread_1" }, "idle");
    const second = store.upsertSession({ id: "second", adapter: "appserver", label: "Second", codexThreadId: "thread_1" }, "attached");

    expect(first.id).toBe("first");
    expect(second.id).toBe("first");
    expect(store.listSessions()).toHaveLength(1);
    expect(store.getSession("first")).toMatchObject({ label: "Second", status: "attached" });
    expect(store.getSession("second")).toBeUndefined();
    store.close();
  });

  it("does not restore a stale attachment or active turn after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tele-codex-thread-restart-"));
    const path = join(dir, "state.db");
    const initial = new Store(path);
    const session = initial.upsertSession({ id: "session_1", adapter: "appserver", label: "one", codexThreadId: "thread_1" }, "idle");
    initial.setActiveTurn(session.id, "turn_1");
    initial.close();

    const restarted = new Store(path);
    expect(restarted.getSession(session.id)).toMatchObject({ status: "detached" });
    expect(restarted.getSession(session.id)?.activeTurnId).toBeUndefined();
    restarted.close();
  });
});

function insertLegacySession(db: Database.Database, id: string, threadId: string, label: string, updatedAt: number, status: string): void {
  db.prepare(
    `insert into sessions
      (id, adapter, label, cwd, codex_thread_id, tmux_target, status, paused, active_turn_id, attach_status,
       submit_strategy, last_probe, last_probe_at, created_at, updated_at)
     values (?, 'appserver', ?, '/workspace', ?, null, ?, 0, null, null, null, null, null, ?, ?)`
  ).run(id, label, threadId, status, updatedAt, updatedAt);
}

function action(sessionId: string): PendingAction {
  return {
    id: "action_1",
    kind: "commandApproval",
    sessionId,
    requestId: 1,
    title: "Approval",
    body: "run",
    payload: {},
    nonce: "nonce",
    expiresAt: Date.now() + 60_000
  };
}

function usage(updatedAt: number, totalTokens: number) {
  return {
    total: { totalTokens, inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    last: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    updatedAt
  };
}
