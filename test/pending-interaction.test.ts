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

  it("rejects a late question callback after Codex resolves a non-blocking request", async () => {
    const store = new Store(":memory:");
    const action = questionAction();
    action.payload = {
      method: "item/tool/requestUserInput",
      params: { ...(action.payload as { params: object }).params, isBlocking: false }
    };
    store.putPendingAction(action);
    const manager = new PendingInteractionManager(store, true);
    const token = callback(manager.actionView(action, 10, 20));
    store.resolvePendingAction(action.id, "resolved");
    let submitted = false;

    expect(await manager.handleCallback(token, { chatId: 10, userId: 20 }, async () => { submitted = true; })).toEqual({
      kind: "notice",
      text: "This request is no longer pending."
    });
    expect(submitted).toBe(false);
    store.close();
  });

  it("keeps MCP labels separate from typed protocol values for every supported field shape", async () => {
    const store = new Store(":memory:");
    const action = elicitationAction();
    store.putPendingAction(action);
    const manager = new PendingInteractionManager(store, true);
    const submit = async () => {};

    let result = await manager.handleCallback(callback(manager.actionView(action, 10, 20)), { chatId: 10, userId: 20 }, submit);
    result = await manager.handleCallback(callbackWithLabel(result, "Production"), { chatId: 10, userId: 20 }, submit);
    result = await manager.handleCallback(callbackWithLabel(result, "Custom answer"), { chatId: 10, userId: 20 }, submit);
    result = manager.handleText(10, 20, "API, Worker")!;
    result = await manager.handleCallback(callbackWithLabel(result, "true"), { chatId: 10, userId: 20 }, submit);
    result = await manager.handleCallback(callbackWithLabel(result, "Custom answer"), { chatId: 10, userId: 20 }, submit);
    result = manager.handleText(10, 20, "3")!;
    result = await manager.handleCallback(callbackWithLabel(result, "Custom answer"), { chatId: 10, userId: 20 }, submit);
    result = manager.handleText(10, 20, "1.5")!;
    result = await manager.handleCallback(callbackWithLabel(result, "eu"), { chatId: 10, userId: 20 }, submit);
    result = await manager.handleCallback(callbackWithLabel(result, "Use default: safe"), { chatId: 10, userId: 20 }, submit);
    result = await manager.handleCallback(callbackWithLabel(result, "Use default: api, worker"), { chatId: 10, userId: 20 }, submit);
    result = await manager.handleCallback(callbackWithLabel(result, "Custom answer"), { chatId: 10, userId: 20 }, submit);
    result = manager.handleText(10, 20, "custom note")!;

    expect(result).toMatchObject({
      kind: "submit",
      decision: {
        actionId: action.id,
        decision: "accept",
        content: {
          environment: "prod",
          targets: ["api", "worker"],
          enabled: true,
          retries: 3,
          ratio: 1.5,
          region: "eu",
          mode: "safe",
          fallbackTargets: ["api", "worker"],
          note: "custom note"
        }
      }
    });
    store.close();
  });

  it.each(["submitting", "failed", "resolved", "cancelled", "orphaned", "expired"] as const)(
    "consumes text for an awaiting %s interaction instead of forwarding it",
    (status) => {
      const store = new Store(":memory:");
      const action = elicitationAction();
      store.putPendingAction(action);
      store.putInteractionDraft(awaitingDraft(action.id));
      if (status === "submitting" || status === "failed") {
        store.claimPendingAction(action.id);
        if (status === "failed") store.failPendingAction(action.id, "transport closed");
      } else {
        store.resolvePendingAction(action.id, status);
      }

      const result = new PendingInteractionManager(store, true).handleText(10, 20, "late answer");

      expect(result).toMatchObject({ kind: "notice" });
      store.close();
    }
  );

  it("consumes expired, missing-action, and stale awaiting drafts with actionable notices", () => {
    const expiredStore = new Store(":memory:");
    const expired = { ...elicitationAction(), expiresAt: Date.now() - 1 };
    expiredStore.putPendingAction(expired);
    expiredStore.putInteractionDraft(awaitingDraft(expired.id));
    expect(new PendingInteractionManager(expiredStore, true).handleText(10, 20, "late")).toMatchObject({
      kind: "notice",
      text: expect.stringMatching(/expired.*\/pending/i)
    });
    expiredStore.close();

    const missingStore = new Store(":memory:");
    missingStore.putInteractionDraft(awaitingDraft("missing"));
    expect(new PendingInteractionManager(missingStore, true).handleText(10, 20, "late")).toMatchObject({
      kind: "notice",
      text: expect.stringMatching(/no longer exists.*\/pending/i)
    });
    missingStore.close();

    const staleStore = new Store(":memory:");
    const stale = elicitationAction();
    staleStore.putPendingAction(stale);
    staleStore.putInteractionDraft({ ...awaitingDraft(stale.id), questionIndex: 99 });
    expect(new PendingInteractionManager(staleStore, true).handleText(10, 20, "late")).toMatchObject({
      kind: "notice",
      text: expect.stringMatching(/stale.*\/pending/i)
    });
    staleStore.close();
  });

  it("consumes duplicate text while the first answer is submitting", async () => {
    const store = new Store(":memory:");
    const action = singleFieldElicitation();
    store.putPendingAction(action);
    const manager = new PendingInteractionManager(store, true);
    const started = await manager.handleCallback(callback(manager.actionView(action, 10, 20)), { chatId: 10, userId: 20 }, async () => {});
    await manager.handleCallback(callbackWithLabel(started, "Custom answer"), { chatId: 10, userId: 20 }, async () => {});

    expect(manager.handleText(10, 20, "first")).toMatchObject({ kind: "submit" });
    store.claimPendingAction(action.id);
    expect(manager.handleText(10, 20, "duplicate")).toMatchObject({
      kind: "notice",
      text: expect.stringMatching(/already being submitted/i)
    });
    store.close();
  });
});

function callback(view: { rows: Array<Array<{ callbackData?: string }>> } | undefined): string {
  const data = view?.rows.flat().find((button) => button.callbackData)?.callbackData;
  if (!data) throw new Error("missing callback");
  return data.slice(3);
}

function callbackWithLabel(
  result: ReturnType<PendingInteractionManager["handleText"]> | Awaited<ReturnType<PendingInteractionManager["handleCallback"]>>,
  label: string
): string {
  if (!result || result.kind !== "view") throw new Error(`expected view containing ${label}`);
  const data = result.view.rows.flat().find((button) => button.label === label)?.callbackData;
  if (!data) throw new Error(`missing callback for ${label}`);
  return data.slice(3);
}

function awaitingDraft(actionId: string) {
  return { actionId, chatId: 10, userId: 20, questionIndex: 0, answers: {}, awaitingText: true };
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

function elicitationAction(): PendingAction {
  return {
    id: "elicitation_1",
    kind: "mcpElicitation",
    sessionId: "session_1",
    requestId: 3,
    title: "MCP form",
    body: "form",
    payload: {
      method: "mcpServer/elicitation/request",
      params: {
        requestedSchema: {
          type: "object",
          required: ["environment", "targets", "enabled", "retries", "ratio", "region", "note"],
          properties: {
            environment: { type: "string", oneOf: [{ title: "Production", const: "prod" }] },
            targets: {
              type: "array",
              items: { oneOf: [{ title: "API", const: "api" }, { title: "Worker", const: "worker" }] }
            },
            enabled: { type: "boolean" },
            retries: { type: "integer", minimum: 1, maximum: 5 },
            ratio: { type: "number", minimum: 0, maximum: 2 },
            region: { type: "string", enum: ["us", "eu"] },
            mode: { type: "string", default: "safe" },
            fallbackTargets: {
              type: "array",
              items: { oneOf: [{ title: "API", const: "api" }, { title: "Worker", const: "worker" }] },
              default: ["api", "worker"]
            },
            note: { type: "string" }
          }
        }
      }
    },
    expiresAt: Date.now() + 60_000
  };
}

function singleFieldElicitation(): PendingAction {
  const action = elicitationAction();
  return {
    ...action,
    id: "single_elicitation",
    payload: {
      method: "mcpServer/elicitation/request",
      params: {
        requestedSchema: {
          type: "object",
          required: ["note"],
          properties: { note: { type: "string" } }
        }
      }
    }
  };
}
