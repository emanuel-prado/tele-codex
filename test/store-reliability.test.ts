import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/store/store.js";
import type { PendingAction } from "../src/types/events.js";

describe("Store reliability state", () => {
  afterEach(() => vi.useRealTimers());
  it("allows exactly one claimant for a pending action", () => {
    const store = new Store(":memory:");
    store.putPendingAction(action(1));
    expect(store.claimPendingAction("action_1")?.status).toBe("submitting");
    expect(store.claimPendingAction("action_1")).toBeUndefined();
    store.resolvePendingAction("action_1", "resolved");
    expect(store.claimPendingAction("action_1")).toBeUndefined();
    store.close();
  });

  it("persists and deduplicates high-signal outbox messages", () => {
    const store = new Store(":memory:");
    store.enqueueOutbox("turn:1:complete", 10, { text: "done" });
    store.enqueueOutbox("turn:1:complete", 10, { text: "duplicate" });
    const due = store.dueOutbox();
    expect(due).toHaveLength(1);
    expect(due[0]?.payload.text).toBe("done");
    store.markOutboxSent(due[0]!.id);
    expect(store.dueOutbox()).toEqual([]);
    store.close();
  });

  it("retries a failed delivery only after its persisted backoff", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
    const store = new Store(":memory:");
    store.enqueueOutbox("turn:retry", 10, { text: "important" });
    const [message] = store.dueOutbox();
    store.retryOutbox(message!.id, 1, "Telegram unavailable");

    expect(store.dueOutbox()).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(store.dueOutbox()).toMatchObject([{ id: message!.id, attempts: 1 }]);
    store.markOutboxSent(message!.id);
    expect(store.outboxCounts()).toEqual({ pending: 0, failed: 0 });
    store.close();
  });

  it("marks actions from a previous app-server connection as orphaned", () => {
    const store = new Store(":memory:");
    store.putPendingAction(action(1));
    store.putPendingAction({ ...action(2), id: "action_2", requestId: 1 });
    expect(store.orphanOpenActions(1)).toBe(1);
    expect(store.getPendingAction("action_1")?.status).toBe("orphaned");
    expect(store.getPendingAction("action_2")?.status).toBe("pending");
    store.close();
  });

  it("resolves request ids only within their connection generation", () => {
    const store = new Store(":memory:");
    store.putPendingAction(action(1));
    store.putPendingAction({ ...action(2), id: "action_2", requestId: 1 });
    store.claimPendingAction("action_1");
    store.claimPendingAction("action_2");

    expect(store.resolvePendingActionByRequestId(1, 1)).toBe("action_1");
    expect(store.getPendingAction("action_1")?.status).toBe("resolved");
    expect(store.getPendingAction("action_2")?.status).toBe("submitting");
    store.close();
  });

  it("keeps failed submissions retryable", () => {
    const store = new Store(":memory:");
    store.putPendingAction(action(1));
    store.claimPendingAction("action_1");
    store.failPendingAction("action_1", "transport closed");

    expect(store.getPendingAction("action_1")).toMatchObject({
      status: "failed",
      failureReason: "transport closed"
    });
    expect(store.listPendingActions()).toHaveLength(1);
    expect(store.claimPendingAction("action_1")?.status).toBe("submitting");
    store.close();
  });

  it("preserves numeric JSON-RPC request ids", () => {
    const store = new Store(":memory:");
    store.putPendingAction(action(1));
    expect(store.getPendingAction("action_1")?.requestId).toBe(1);
    expect(store.getPendingAction("action_1")?.connectionGeneration).toBe(1);
    store.close();
  });

  it("clears only attachments owned by the disconnected generation", () => {
    const store = new Store(":memory:");
    store.upsertSession({ id: "session_1", adapter: "appserver", label: "one", codexThreadId: "thread_1", connectionGeneration: 1 }, "idle");
    store.upsertSession({ id: "session_2", adapter: "appserver", label: "two", codexThreadId: "thread_2", connectionGeneration: 2 }, "idle");

    expect(store.clearSessionAttachments(1)).toEqual(["session_1"]);
    expect(store.getSession("session_1")).toMatchObject({ status: "detached" });
    expect(store.getSession("session_1")?.connectionGeneration).toBeUndefined();
    expect(store.getSession("session_2")).toMatchObject({ status: "idle", connectionGeneration: 2 });
    store.close();
  });
});

function action(connectionGeneration: number): PendingAction {
  return {
    id: "action_1",
    kind: "commandApproval",
    sessionId: "session_1",
    requestId: 1,
    connectionGeneration,
    title: "Approval",
    body: "run",
    payload: { method: "item/commandExecution/requestApproval", params: {} },
    expiresAt: Date.now() + 60_000
  };
}
