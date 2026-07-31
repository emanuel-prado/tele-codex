import { describe, expect, it } from "vitest";
import { PendingInteractionManager } from "../src/telegram/pending-interaction.js";
import { Store } from "../src/store/store.js";
import type { PendingAction } from "../src/types/events.js";

describe("PendingInteractionManager", () => {
  it("collects several questions and submits one answer map", () => {
    const store = new Store(":memory:");
    const action = questionAction();
    store.putPendingAction(action);
    const manager = new PendingInteractionManager(store, true);

    const start = callback(manager.actionView(action, 10));
    const first = manager.handleCallback(start, 10, 20);
    expect(first.kind).toBe("view");
    const firstChoice = callback(first.kind === "view" ? first.view : undefined);
    const second = manager.handleCallback(firstChoice, 10, 20);
    expect(second.kind).toBe("view");
    const secondChoice = callback(second.kind === "view" ? second.view : undefined);
    const result = manager.handleCallback(secondChoice, 10, 20);

    expect(result).toEqual({
      kind: "submit",
      decision: {
        actionId: action.id,
        decision: "accept",
        answers: {
          first: { answers: ["A"] },
          second: { answers: ["B"] }
        }
      },
      text: "Answers submitted to Codex."
    });
    store.close();
  });

  it("uses short, chat-bound, one-shot callback tokens", () => {
    const store = new Store(":memory:");
    const action = questionAction();
    store.putPendingAction(action);
    const manager = new PendingInteractionManager(store, true);
    const token = callback(manager.actionView(action, 10));

    expect(`cb:${token}`.length).toBeLessThanOrEqual(64);
    expect(manager.handleCallback(token, 11, 20).kind).toBe("notice");
    expect(manager.handleCallback(token, 10, 20).kind).toBe("view");
    expect(manager.handleCallback(token, 10, 20).kind).toBe("notice");
    store.close();
  });

  it("refuses secret question collection", () => {
    const store = new Store(":memory:");
    const action = questionAction(true);
    store.putPendingAction(action);
    const view = new PendingInteractionManager(store, true).actionView(action, 10);
    expect(view.rows).toEqual([]);
    expect(view.text).toContain("not end-to-end encrypted");
    store.close();
  });

  it("does not consume a decision control until submission succeeds", () => {
    const store = new Store(":memory:");
    const action = approvalAction();
    store.putPendingAction(action);
    const manager = new PendingInteractionManager(store, true);
    const token = callback(manager.actionView(action, 10));

    expect(manager.handleCallback(token, 10, 20).kind).toBe("submit");
    store.claimPendingAction(action.id);
    store.failPendingAction(action.id, "transport closed");
    expect(manager.actionView(store.getPendingAction(action.id)!, 10).text).toContain("transport closed");
    expect(manager.handleCallback(token, 10, 20).kind).toBe("submit");
    store.close();
  });

  it("rejects a callback after its connection is orphaned", () => {
    const store = new Store(":memory:");
    const action = approvalAction();
    store.putPendingAction(action);
    const manager = new PendingInteractionManager(store, true);
    const token = callback(manager.actionView(action, 10));
    store.orphanOpenActions(action.connectionGeneration);

    expect(manager.handleCallback(token, 10, 20)).toEqual({
      kind: "notice",
      text: "This request is no longer pending."
    });
    store.close();
  });
});

function callback(view: { rows: Array<Array<{ callbackData?: string }>> } | undefined): string {
  const data = view?.rows.flat().find((button) => button.callbackData)?.callbackData;
  if (!data) throw new Error("missing callback");
  return data.slice(3);
}

function approvalAction(): PendingAction {
  return {
    id: "approval_1",
    kind: "commandApproval",
    sessionId: "session_1",
    requestId: 2,
    connectionGeneration: 1,
    title: "Approval",
    body: "run",
    payload: { method: "item/commandExecution/requestApproval", params: {} },
    nonce: "nonce",
    expiresAt: Date.now() + 60_000
  };
}

function questionAction(secret = false): PendingAction {
  return {
    id: "action_1",
    kind: "question",
    sessionId: "session_1",
    requestId: 1,
    title: "Codex asks",
    body: "questions",
    payload: {
      method: "item/tool/requestUserInput",
      params: {
        questions: [
          { id: "first", header: "First", question: "First?", isOther: false, isSecret: secret, options: [{ label: "A", description: "" }] },
          { id: "second", header: "Second", question: "Second?", isOther: false, isSecret: false, options: [{ label: "B", description: "" }] }
        ]
      }
    },
    nonce: "nonce",
    expiresAt: Date.now() + 60_000
  };
}
