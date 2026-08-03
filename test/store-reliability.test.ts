import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(store.getPendingAction("action_1")).toMatchObject({ status: "orphaned", body: "", payload: {} });
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

  it("scrubs terminal action content while preserving retryable failures", () => {
    const store = new Store(":memory:");
    const sensitive = {
      ...action(1),
      body: "run with private approval context",
      payload: { params: { command: "private command", answer: "private answer" } }
    };
    store.putPendingAction(sensitive);
    store.putCallbackToken({
      token: "sensitive-control", actionId: sensitive.id, resourceKind: "pending-action", chatId: 1, userId: 2,
      operation: "decision", payload: { value: "private approval answer" }, expiresAt: Date.now() + 60_000
    });
    store.putInteractionDraft({
      actionId: sensitive.id, chatId: 1, userId: 2, questionIndex: 0,
      answers: { answer: { answers: ["private draft answer"] } }, awaitingText: false
    });
    store.claimPendingAction(sensitive.id);
    store.failPendingAction(sensitive.id, "transport closed");
    expect(store.getPendingAction(sensitive.id)).toMatchObject({ body: sensitive.body, payload: sensitive.payload });

    store.claimPendingAction(sensitive.id);
    store.resolvePendingAction(sensitive.id, "resolved");

    expect(store.getPendingAction(sensitive.id)).toMatchObject({ status: "resolved", body: "", payload: {} });
    expect(store.getInteractionDraft(sensitive.id, 1, 2)?.answers).toEqual({});
    expect(store.claimCallbackToken("sensitive-control", 1, 2, "claim")?.payload).toEqual({});
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

  it("rolls back detach when its attachment transition fails and remains consistent after restart", async () => {
    const fixture = await fileStore();
    const session = fixture.store.upsertSession(
      { id: "session_1", adapter: "appserver", label: "one", codexThreadId: "thread_1", connectionGeneration: 1 },
      "idle"
    );
    fixture.store.setActiveTurn(session.id, "turn_1");
    fixture.db.exec(`create trigger fail_detach before update on appserver_attachments
      when new.status = 'detached' begin select raise(abort, 'injected detach failure'); end`);

    expect(() => fixture.store.markThreadDetached(session.id)).toThrow(/injected detach failure/);
    expect(fixture.store.getSession(session.id)).toMatchObject({ status: "active", activeTurnId: "turn_1" });

    fixture.db.exec("drop trigger fail_detach");
    fixture.close();
    const restarted = new Store(fixture.path);
    expect(restarted.getSession(session.id)).toMatchObject({ status: "detached" });
    expect(restarted.getSession(session.id)?.activeTurnId).toBeUndefined();
    restarted.close();
  });

  it("rolls back a new Active Turn when its attachment transition fails", async () => {
    const fixture = await fileStore();
    const session = fixture.store.upsertSession(
      { id: "session_1", adapter: "appserver", label: "one", codexThreadId: "thread_1", connectionGeneration: 1 },
      "idle"
    );
    fixture.db.exec(`create trigger fail_active before update on appserver_attachments
      when new.status = 'active' begin select raise(abort, 'injected active failure'); end`);

    expect(() => fixture.store.setActiveTurn(session.id, "turn_1")).toThrow(/injected active failure/);
    expect(fixture.store.getSession(session.id)).toMatchObject({ status: "idle" });
    expect(fixture.store.getSession(session.id)?.activeTurnId).toBeUndefined();
    fixture.close();
  });

  it("rolls back Active Turn completion when its attachment transition fails", async () => {
    const fixture = await fileStore();
    const session = fixture.store.upsertSession(
      { id: "session_1", adapter: "appserver", label: "one", codexThreadId: "thread_1", connectionGeneration: 1 },
      "idle"
    );
    fixture.store.setActiveTurn(session.id, "turn_1");
    fixture.db.exec(`create trigger fail_completion before update on appserver_attachments
      when new.status = 'error' begin select raise(abort, 'injected completion failure'); end`);

    expect(() => fixture.store.setActiveTurn(session.id, null, "error")).toThrow(/injected completion failure/);
    expect(fixture.store.getSession(session.id)).toMatchObject({ status: "active", activeTurnId: "turn_1" });
    fixture.close();
  });

  it("rolls back Telegram references when action-message insertion fails", async () => {
    const fixture = await fileStore();
    fixture.store.putPendingAction(action(1));
    fixture.db.exec(`create trigger fail_action_message before insert on action_messages
      begin select raise(abort, 'injected Telegram reference failure'); end`);

    expect(() => fixture.store.setTelegramMessage("action_1", 10, 20)).toThrow(/injected Telegram reference failure/);
    expect(fixture.db.prepare(
      "select telegram_chat_id, telegram_message_id from pending_actions where id = 'action_1'"
    ).get()).toEqual({ telegram_chat_id: null, telegram_message_id: null });
    expect(fixture.store.listTelegramMessages("action_1")).toEqual([]);
    fixture.close();
  });

  it("rolls back thread creation when attachment insertion fails", async () => {
    const fixture = await fileStore();
    fixture.db.exec(`create trigger fail_attachment before insert on appserver_attachments
      begin select raise(abort, 'injected attachment failure'); end`);

    expect(() => fixture.store.upsertSession(
      { id: "session_1", adapter: "appserver", label: "one", codexThreadId: "thread_1", connectionGeneration: 1 },
      "idle"
    )).toThrow(/injected attachment failure/);
    expect(fixture.store.getSession("session_1")).toBeUndefined();
    fixture.close();
  });
});

async function fileStore() {
  const directory = await mkdtemp(join(tmpdir(), "tele-codex-atomic-store-"));
  const path = join(directory, "state.sqlite");
  const store = new Store(path);
  const db = new Database(path);
  return {
    path,
    store,
    db,
    close() {
      db.close();
      store.close();
    }
  };
}

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
