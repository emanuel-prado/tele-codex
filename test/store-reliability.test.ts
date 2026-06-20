import { describe, expect, it } from "vitest";
import { Store } from "../src/store/store.js";
import type { PendingAction } from "../src/types/events.js";

describe("Store reliability state", () => {
  it("allows exactly one claimant for a pending action", () => {
    const store = new Store(":memory:");
    store.putPendingAction(action());
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

  it("marks actions from a previous app-server connection as orphaned", () => {
    const store = new Store(":memory:");
    store.putPendingAction(action());
    expect(store.orphanOpenActions()).toBe(1);
    expect(store.getPendingAction("action_1")?.status).toBe("orphaned");
    expect(store.listPendingActions()).toEqual([]);
    store.close();
  });

  it("preserves numeric JSON-RPC request ids", () => {
    const store = new Store(":memory:");
    store.putPendingAction(action());
    expect(store.getPendingAction("action_1")?.requestId).toBe(1);
    store.close();
  });
});

function action(): PendingAction {
  return {
    id: "action_1",
    kind: "commandApproval",
    sessionId: "session_1",
    requestId: 1,
    title: "Approval",
    body: "run",
    payload: { method: "item/commandExecution/requestApproval", params: {} },
    nonce: "nonce",
    expiresAt: Date.now() + 60_000
  };
}
