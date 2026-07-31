import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/runtime/session-manager.js";
import { Store } from "../src/store/store.js";
import type { CodexAdapter } from "../src/types/adapter.js";
import type { CodexThreadSummary } from "../src/types/control.js";
import type { SessionRef } from "../src/types/events.js";

describe("SessionManager resume", () => {
  it("resumes the newest remote Codex thread", async () => {
    const store = new Store(":memory:");
    const calls: Array<{ operation: string; value?: unknown }> = [];
    const appserver = fakeAppServer(store, [{ id: "thread_newest", updatedAt: 2 }], calls);
    const manager = new SessionManager(
      { appserver, pty: fakePty() },
      store,
      "appserver",
      silentLogger()
    );

    const session = await manager.resumeLatestThread();

    expect(session.codexThreadId).toBe("thread_newest");
    expect(calls).toEqual([
      { operation: "list", value: 1 },
      { operation: "resume", value: "thread_newest" }
    ]);
    expect(manager.getActiveSession()?.id).toBe(session.id);
    store.close();
  });

  it("reports when there is no Codex history to resume", async () => {
    const store = new Store(":memory:");
    const manager = new SessionManager(
      { appserver: fakeAppServer(store, [], []), pty: fakePty() },
      store,
      "appserver",
      silentLogger()
    );

    await expect(manager.resumeLatestThread()).rejects.toThrow("No previous Codex sessions found.");
    store.close();
  });
});

describe("SessionManager approval acknowledgement", () => {
  it("keeps app-server actions submitting until server acknowledgement", async () => {
    const store = new Store(":memory:");
    const appserver = fakeAppServer(store, [], []);
    const manager = new SessionManager({ appserver, pty: fakePty() }, store, "appserver", silentLogger());
    store.upsertSession({ id: "session_1", adapter: "appserver", label: "one", codexThreadId: "thread_1" }, "idle");
    store.putPendingAction(pendingAction());

    await manager.respondAction({ actionId: "action_1", decision: "accept" });

    expect(store.getPendingAction("action_1")?.status).toBe("submitting");
    await expect(manager.respondAction({ actionId: "action_1", decision: "accept" })).rejects.toThrow(/no longer pending/i);
    store.resolvePendingActionByRequestId(7, 1);
    expect(store.getPendingAction("action_1")?.status).toBe("resolved");
    store.close();
  });

  it("orphans a submission when Codex never acknowledges it", async () => {
    const store = new Store(":memory:");
    const manager = new SessionManager(
      { appserver: fakeAppServer(store, [], []), pty: fakePty() },
      store,
      "appserver",
      silentLogger()
    );
    store.upsertSession({ id: "session_1", adapter: "appserver", label: "one", codexThreadId: "thread_1" }, "idle");
    store.putPendingAction({ ...pendingAction(), expiresAt: Date.now() - 1 });
    store.claimExpiredAction("action_1");

    expect(await manager.expirePendingActions()).toBe(1);
    expect(store.getPendingAction("action_1")?.status).toBe("orphaned");
    store.close();
  });

  it("keeps a submission failure available for retry", async () => {
    const store = new Store(":memory:");
    const manager = new SessionManager(
      { appserver: fakeAppServer(store, [], []), pty: fakePty() },
      store,
      "appserver",
      silentLogger()
    );
    store.putPendingAction(pendingAction());

    await expect(manager.respondAction({ actionId: "action_1", decision: "accept" })).rejects.toThrow(/session/i);
    expect(store.getPendingAction("action_1")).toMatchObject({ status: "failed" });

    store.upsertSession({ id: "session_1", adapter: "appserver", label: "one", codexThreadId: "thread_1" }, "idle");
    await manager.respondAction({ actionId: "action_1", decision: "accept" });
    expect(store.getPendingAction("action_1")?.status).toBe("submitting");
    store.close();
  });
});

function fakeAppServer(
  store: Store,
  threads: CodexThreadSummary[],
  calls: Array<{ operation: string; value?: unknown }>
): CodexAdapter {
  return {
    kind: "appserver",
    async listThreads(limit) {
      calls.push({ operation: "list", value: limit });
      return threads;
    },
    async resumeThread(threadId) {
      calls.push({ operation: "resume", value: threadId });
      const session: SessionRef = {
        id: `session_${threadId}`,
        adapter: "appserver",
        label: threadId,
        codexThreadId: threadId
      };
      store.upsertSession(session, "idle");
      return session;
    },
    async listModels() {
      return [];
    },
    ...unusedAdapterMethods()
  };
}

function fakePty(): CodexAdapter {
  return { kind: "pty", ...unusedAdapterMethods() };
}

function unusedAdapterMethods(): Omit<CodexAdapter, "kind"> {
  return {
    async start() {
      throw new Error("unused");
    },
    async attach() {
      throw new Error("unused");
    },
    async sendUserText() {},
    async respondAction() {},
    async interrupt() {},
    async kill() {},
    async getRecentLog() {
      return [];
    },
    async *events() {}
  };
}

function silentLogger(): never {
  return { error() {} } as never;
}

function pendingAction() {
  return {
    id: "action_1",
    kind: "commandApproval" as const,
    sessionId: "session_1",
    requestId: 7,
    connectionGeneration: 1,
    title: "Approval",
    body: "run",
    payload: { method: "item/commandExecution/requestApproval", params: {} },
    nonce: "nonce",
    expiresAt: Date.now() + 60_000
  };
}
