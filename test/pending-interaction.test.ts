import { describe, expect, it } from "vitest";
import { PendingInteractionManager } from "../src/telegram/pending-interaction.js";
import { Store } from "../src/store/store.js";
import type { PendingAction } from "../src/types/events.js";

describe("PendingInteractionManager", () => {
  it("collects several questions and submits one answer map", async () => {
    const store = new Store(":memory:");
    const action = questionAction();
    store.putPendingAction(action);
    const manager = new PendingInteractionManager(store, true);

    const submit = async () => {};
    const start = callback(manager.actionView(action, 10, 20));
    const first = await manager.handleCallback(start, { chatId: 10, userId: 20 }, submit);
    expect(first.kind).toBe("view");
    const firstChoice = callback(first.kind === "view" ? first.view : undefined);
    const second = await manager.handleCallback(firstChoice, { chatId: 10, userId: 20 }, submit);
    expect(second.kind).toBe("view");
    const secondChoice = callback(second.kind === "view" ? second.view : undefined);
    const result = await manager.handleCallback(secondChoice, { chatId: 10, userId: 20 }, submit);

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

  it("uses short, controller/chat-bound, one-shot callback tokens", async () => {
    const store = new Store(":memory:");
    const action = questionAction();
    store.putPendingAction(action);
    const manager = new PendingInteractionManager(store, true);
    const token = callback(manager.actionView(action, 10, 20));
    const submit = async () => {};

    expect(`cb:${token}`.length).toBeLessThanOrEqual(64);
    expect((await manager.handleCallback(token, { chatId: 10, userId: 21 }, submit)).kind).toBe("notice");
    expect((await manager.handleCallback(token, { chatId: 11, userId: 20 }, submit)).kind).toBe("notice");
    expect((await manager.handleCallback(token, { chatId: 10, userId: 20 }, submit)).kind).toBe("view");
    expect((await manager.handleCallback(token, { chatId: 10, userId: 20 }, submit)).kind).toBe("notice");
    store.close();
  });

  it("refuses secret question collection", () => {
    const store = new Store(":memory:");
    const action = questionAction(true);
    store.putPendingAction(action);
    const view = new PendingInteractionManager(store, true).actionView(action, 10, 20);
    expect(view.rows).toEqual([]);
    expect(view.text).toContain("not end-to-end encrypted");
    store.close();
  });

  it("does not consume a decision control until submission succeeds", async () => {
    const store = new Store(":memory:");
    const action = approvalAction();
    store.putPendingAction(action);
    const manager = new PendingInteractionManager(store, true);
    const token = callback(manager.actionView(action, 10, 20));

    await expect(manager.handleCallback(token, { chatId: 10, userId: 20 }, async () => {
      throw new Error("transport closed");
    })).rejects.toThrow("transport closed");
    expect((await manager.handleCallback(token, { chatId: 10, userId: 20 }, async () => {})).kind).toBe("submit");
    store.close();
  });

  it("rejects a callback after its connection is orphaned", async () => {
    const store = new Store(":memory:");
    const action = approvalAction();
    store.putPendingAction(action);
    const manager = new PendingInteractionManager(store, true);
    const token = callback(manager.actionView(action, 10, 20));
    store.orphanOpenActions(action.connectionGeneration);

    expect(await manager.handleCallback(token, { chatId: 10, userId: 20 }, async () => {})).toEqual({
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
    expiresAt: Date.now() + 60_000
  };
}
