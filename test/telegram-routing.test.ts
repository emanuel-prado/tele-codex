import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/runtime/session-manager.js";
import { Store } from "../src/store/store.js";
import { TelegramRouting } from "../src/telegram/routing.js";
import type { AppServerRuntime } from "../src/types/adapter.js";
import type { SessionRef } from "../src/types/events.js";

describe("TelegramRouting", () => {
  it("keeps picker and compose state isolated by chat and user without invalidating other pickers", async () => {
    const fixture = setup();
    const one = fixture.addThread("session_1", "thread_1", "one");
    const two = fixture.addThread("session_2", "thread_2", "two");
    const first = fixture.routing.pickerToken(10, 100, { id: "thread_1" }, one);
    const second = fixture.routing.pickerToken(10, 100, { id: "thread_2" }, two);

    await expect(fixture.routing.selectPicker(first, 11, 100)).rejects.toThrow(/another chat/i);
    await fixture.routing.selectPicker(first, 10, 100);
    expect(await fixture.routing.routeText(10, 101, "wrong user")).toBeUndefined();
    expect(await fixture.routing.routeText(11, 100, "wrong chat")).toBeUndefined();
    await fixture.routing.routeText(10, 100, "to one");

    await fixture.routing.selectPicker(second, 10, 100);
    await fixture.routing.routeText(10, 100, "to two");
    expect(fixture.sent).toEqual([
      { sessionId: "session_1", text: "to one" },
      { sessionId: "session_2", text: "to two" }
    ]);
    fixture.close();
  });

  it("persists one-shot compose state across routing service restarts and consumes it once", async () => {
    const fixture = setup();
    const session = fixture.addThread("session_1", "thread_1", "one");
    const token = fixture.routing.pickerToken(10, 100, { id: "thread_1" }, session);
    await fixture.routing.selectPicker(token, 10, 100);

    const restarted = new TelegramRouting(fixture.store, fixture.manager);
    expect((await restarted.routeText(10, 100, "after restart"))?.source).toBe("compose");
    expect(await restarted.routeText(10, 100, "not sent twice")).toBeUndefined();
    await expect(restarted.selectPicker(token, 10, 100)).rejects.toThrow(/already used/i);
    fixture.close();
  });

  it("persists compose state across a store restart and explicitly resumes the detached thread", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tele-codex-routing-restart-"));
    const path = join(dir, "state.sqlite");
    const before = setup(path);
    const session = before.addThread("session_1", "thread_1", "one");
    const token = before.routing.pickerToken(10, 100, { id: "thread_1" }, session);
    await before.routing.selectPicker(token, 10, 100);
    before.close();

    const after = setup(path);
    expect(after.store.getSession("session_1")?.status).toBe("detached");
    expect((await after.routing.routeText(10, 100, "after process restart"))?.source).toBe("compose");
    expect(after.resumed).toEqual(["session_1"]);
    expect(after.sent).toEqual([{ sessionId: "session_1", text: "after process restart" }]);
    after.close();
  });

  it("routes replies through persisted bot-message associations", async () => {
    const fixture = setup();
    fixture.addThread("session_1", "thread_1", "one");
    fixture.store.setMessageThread(10, 55, "session_1");

    const routed = await fixture.routing.routeText(10, 100, "reply", 55);

    expect(routed).toMatchObject({ source: "reply", session: { id: "session_1" } });
    expect(fixture.sent).toEqual([{ sessionId: "session_1", text: "reply" }]);
    expect(await fixture.routing.routeText(11, 100, "cross-chat reply", 55)).toBeUndefined();
    fixture.close();
  });

  it("supports direct and opt-in sticky routing to two concurrent threads", async () => {
    const fixture = setup();
    fixture.addThread("session_1", "thread_1", "one");
    fixture.addThread("session_2", "thread_2", "two");

    await fixture.routing.sendDirect(10, "one", "direct one");
    await fixture.routing.setSticky(10, 100, "thread_2");
    expect((await fixture.routing.routeText(10, 100, "sticky two"))?.source).toBe("sticky");
    fixture.routing.clearSticky(10, 100);
    expect(await fixture.routing.routeText(10, 100, "unrouted")).toBeUndefined();
    expect(fixture.sent).toEqual([
      { sessionId: "session_1", text: "direct one" },
      { sessionId: "session_2", text: "sticky two" }
    ]);
    fixture.close();
  });

  it("expires compose state and reports invalid or detached targets", async () => {
    const fixture = setup();
    fixture.store.putRoutingCompose({
      chatId: 10,
      userId: 100,
      sessionId: "missing",
      expectedVersion: 1,
      expiresAt: Date.now() - 1
    });
    expect(await fixture.routing.routeText(10, 100, "expired")).toBeUndefined();

    fixture.store.putRoutingCompose({
      chatId: 10,
      userId: 100,
      sessionId: "missing",
      expectedVersion: 1,
      expiresAt: Date.now() + 60_000
    });
    await expect(fixture.routing.routeText(10, 100, "invalid")).rejects.toThrow(/no longer exists/i);

    const detached = fixture.addThread("session_2", "thread_2", "two", "detached");
    const token = fixture.routing.pickerToken(10, 100, { id: "thread_2" }, detached);
    const selected = await fixture.routing.selectPicker(token, 10, 100);
    expect(selected.status).toBe("idle");
    expect(fixture.resumed).toEqual(["session_2"]);
    fixture.close();
  });
});

function setup(path = ":memory:") {
  const store = new Store(path);
  const sent: Array<{ sessionId: string; text: string }> = [];
  const resumed: string[] = [];
  const appserver: AppServerRuntime = {
    async start() { throw new Error("unused"); },
    async attach() { throw new Error("unused"); },
    async resume(session) {
      resumed.push(session.id);
      return store.upsertSession(session, "idle");
    },
    async resumeThread(threadId) {
      const existing = store.getSessionByCodexThreadId(threadId);
      if (existing) return store.upsertSession(existing, "idle");
      return store.upsertSession({ id: `session_${threadId}`, adapter: "appserver", label: threadId, codexThreadId: threadId }, "idle");
    },
    async listThreads() { return []; },
    async searchThreads() { return []; },
    async listModels() { return []; },
    async sendUserText(sessionId, text) { sent.push({ sessionId, text }); },
    async respondAction() {},
    async updateSettings() {},
    async compactThread() {},
    async archiveThread() {},
    async setCollaborationMode() {},
    async readRateLimits() { return undefined; },
    async getGoal() { return undefined; },
    async setGoal() { throw new Error("unused"); },
    async clearGoal() { return false; },
    async listBackgroundTerminals() { return []; },
    async terminateBackgroundTerminal() { return false; },
    async detach() {},
    async interrupt() {},
    async getRecentLog() { return []; },
    close() {},
    async *events() {}
  };
  const manager = new SessionManager(appserver, store, { error() {} } as never);
  return {
    store,
    manager,
    routing: new TelegramRouting(store, manager),
    sent,
    resumed,
    addThread(id: string, threadId: string, label: string, status: "idle" | "detached" = "idle") {
      const ref: SessionRef = { id, adapter: "appserver", label, codexThreadId: threadId };
      store.upsertSession(ref, "idle");
      if (status === "detached") store.markThreadDetached(id);
      return store.getSession(id)!;
    },
    close() { store.close(); }
  };
}
