import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServerAdapter } from "../src/adapters/app-server-adapter.js";
import type { AppConfig } from "../src/config.js";
import { Store } from "../src/store/store.js";
import type { CodexEvent } from "../src/types/events.js";
import { FakeAppServer } from "./support/fake-app-server.js";

afterEach(() => vi.useRealTimers());

describe("app-server lifecycle scenarios", () => {
  it("starts a thread, completes a turn, and confirms an approval", async () => {
    const scenario = createScenario();
    scenario.server.respondTo("thread/start", { thread: { id: "thread-a" }, model: "gpt-test" });
    scenario.server.respondTo("turn/start", { turn: { id: "turn-a" } });

    const session = await scenario.adapter.start({ cwd: "/tmp", prompt: "ship it" });
    scenario.server.notification("turn/started", { threadId: "thread-a", turn: { id: "turn-a" } });
    scenario.server.notification("item/agentMessage/delta", { threadId: "thread-a", turnId: "turn-a", itemId: "message-a", delta: "done" });
    scenario.server.notification("turn/completed", { threadId: "thread-a", turn: { id: "turn-a", status: "completed" } });
    scenario.server.serverRequest(41, "item/commandExecution/requestApproval", { threadId: "thread-a", turnId: "turn-b", command: "npm test" });

    const events = await takeEvents(scenario.adapter.events(), 3);
    expect(events.map((event) => event.type), scenario.server.formatTrace()).toEqual([
      "agentMessage", "taskCompleted", "approvalRequested"
    ]);
    const approval = events.find((event): event is Extract<CodexEvent, { type: "approvalRequested" }> => event.type === "approvalRequested");
    expect(approval, scenario.server.formatTrace()).toBeDefined();
    scenario.store.claimPendingAction(approval!.action.id);
    await scenario.adapter.respondAction({ actionId: approval!.action.id, decision: "accept" });
    scenario.server.notification("serverRequest/resolved", { threadId: "thread-a", requestId: 41 });
    const resolved = await takeEvents(scenario.adapter.events(), 1);

    expect(resolved[0], scenario.server.formatTrace()).toMatchObject({ type: "actionResolved", actionId: approval!.action.id });
    expect(scenario.store.getPendingAction(approval!.action.id)?.status).toBe("resolved");
    expect(scenario.server.trace.some((entry) => "id" in entry.message && entry.message.id === 41 && "result" in entry.message)).toBe(true);
    expect(scenario.store.getSession(session.id)).toMatchObject({ status: "idle", codexThreadId: "thread-a" });
    scenario.close();
  });

  it("orphans a pending approval on disconnect and rejects its stale callback after reconnect", async () => {
    vi.useFakeTimers();
    const scenario = createScenario();
    scenario.server.respondTo("thread/start", { thread: { id: "thread-a" } });
    scenario.server.respondTo("thread/resume", { thread: { id: "thread-a" } });
    const session = await scenario.adapter.start({ cwd: "/tmp" });
    scenario.server.serverRequest(7, "item/commandExecution/requestApproval", { threadId: "thread-a", command: "true" });
    const approval = (await takeEvents(scenario.adapter.events(), 1)).find(
      (event): event is Extract<CodexEvent, { type: "approvalRequested" }> => event.type === "approvalRequested"
    )!;
    scenario.server.disconnect(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await scenario.adapter.resume(scenario.store.getSession(session.id)!);

    await expect(scenario.adapter.respondAction({ actionId: approval.action.id, decision: "accept" }))
      .rejects.toThrow(/disconnected app-server connection/i);
    scenario.server.notification("serverRequest/resolved", { threadId: "thread-a", requestId: 7 }, 1);
    expect(scenario.store.getPendingAction(approval.action.id)?.status, scenario.server.formatTrace()).toBe("orphaned");
    expect(scenario.store.getSession(session.id)?.connectionGeneration).toBe(2);
    scenario.close();
  });

  it("keeps two threads isolated and distinguishes interrupt, detach, and archive", async () => {
    const scenario = createScenario();
    let nextThread = 0;
    scenario.server.respondTo("thread/start", () => ({ thread: { id: `thread-${++nextThread}` } }));
    scenario.server.respondTo("turn/start", (params: unknown) => {
      const threadId = (params as { threadId: string }).threadId;
      return { turn: { id: `turn-${threadId}` } };
    });
    scenario.server.respondTo("turn/interrupt", {});
    scenario.server.respondTo("thread/archive", {});
    const first = await scenario.adapter.start({ cwd: "/tmp/a", prompt: "a" });
    const second = await scenario.adapter.start({ cwd: "/tmp/b", prompt: "b" });
    scenario.server.notification("item/agentMessage/delta", { threadId: "thread-2", delta: "only b" });
    await scenario.adapter.interrupt(first.id);
    await scenario.adapter.detach(first.id);
    await scenario.adapter.archiveThread(second.id);
    const events = await takeEvents(scenario.adapter.events(), 1);

    expect(events.find((event) => event.type === "agentMessage"), scenario.server.formatTrace()).toMatchObject({ sessionId: second.id, text: "only b" });
    expect(scenario.server.messages("turn/interrupt")).toHaveLength(1);
    expect(scenario.server.messages("thread/archive")).toHaveLength(1);
    expect(scenario.store.getSession(first.id)?.status).toBe("detached");
    expect(scenario.store.getSession(second.id)?.status).toBe("archived");
    scenario.close();
  });

  it("interrupts only a proven active turn on the current attachment and transitions it to idle", async () => {
    const scenario = createScenario();
    scenario.server.respondTo("thread/start", { thread: { id: "thread-a" } });
    scenario.server.respondTo("turn/start", { turn: { id: "turn-a" } });
    scenario.server.respondTo("turn/interrupt", {});
    const session = await scenario.adapter.start({ cwd: "/tmp", prompt: "work" });

    expect(scenario.store.getSession(session.id)).toMatchObject({
      status: "active",
      activeTurnId: "turn-a",
      connectionGeneration: 1
    });
    await scenario.adapter.interrupt(session.id);

    expect(scenario.server.messages("turn/interrupt")[0]?.message).toMatchObject({
      params: { threadId: "thread-a", turnId: "turn-a" }
    });
    expect(scenario.store.getSession(session.id)?.status).toBe("idle");
    expect(scenario.store.getSession(session.id)?.activeTurnId).toBeUndefined();
    scenario.close();
  });

  it("rejects interrupt while disconnected and after reconnect until the thread and a new turn are proven", async () => {
    vi.useFakeTimers();
    const scenario = createScenario();
    scenario.server.respondTo("thread/start", { thread: { id: "thread-a" } });
    scenario.server.respondTo("thread/resume", { thread: { id: "thread-a" } });
    scenario.server.respondTo("turn/start", { turn: { id: "turn-new" } });
    scenario.server.respondTo("turn/interrupt", {});
    const session = await scenario.adapter.start({ cwd: "/tmp", prompt: "work" });

    scenario.server.disconnect(1);
    expect(scenario.store.getSession(session.id)?.status).toBe("detached");
    expect(scenario.store.getSession(session.id)?.activeTurnId).toBeUndefined();
    await expect(scenario.adapter.interrupt(session.id)).rejects.toThrow(/disconnected.*resume/i);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(scenario.adapter.interrupt(session.id)).rejects.toThrow(/current.*attachment.*resume/i);
    await scenario.adapter.resume(scenario.store.getSession(session.id)!);
    await expect(scenario.adapter.interrupt(session.id)).rejects.toMatchObject({
      name: "AppServerFailure",
      kind: "invalid_state",
      method: "turn/interrupt",
      message: expect.stringMatching(/no active.*turn/i)
    });

    await scenario.adapter.sendUserText(session.id, "new work");
    await expect(scenario.adapter.interrupt(session.id)).resolves.toBeUndefined();
    scenario.close();
  });

  it("rejects stale attachment generations and interrupt timeouts without clearing the active turn", async () => {
    const scenario = createScenario();
    scenario.server.respondTo("thread/start", { thread: { id: "thread-a" } });
    scenario.server.respondTo("turn/start", { turn: { id: "turn-a" } });
    scenario.server.respondTo("turn/interrupt", () => {
      throw new Error("Codex app-server request timed out after 100ms: turn/interrupt");
    });
    const session = await scenario.adapter.start({ cwd: "/tmp", prompt: "work" });
    const stored = scenario.store.getSession(session.id)!;
    scenario.store.upsertSession({ ...stored, connectionGeneration: 99 }, "active");

    await expect(scenario.adapter.interrupt(session.id)).rejects.toThrow(/stale.*attachment.*resume/i);
    expect(scenario.server.messages("turn/interrupt")).toHaveLength(0);

    scenario.store.upsertSession({ ...stored, connectionGeneration: 1 }, "active");
    await expect(scenario.adapter.interrupt(session.id)).rejects.toThrow(/timed out/i);
    expect(scenario.store.getSession(session.id)).toMatchObject({ status: "active", activeTurnId: "turn-a" });
    scenario.close();
  });

  it("maps an interrupted turn to idle and an actual failed turn to error", async () => {
    const interrupted = createScenario();
    interrupted.server.respondTo("thread/start", { thread: { id: "thread-a" } });
    interrupted.server.respondTo("turn/start", { turn: { id: "turn-a" } });
    const interruptedSession = await interrupted.adapter.start({ cwd: "/tmp", prompt: "work" });
    interrupted.server.notification("turn/completed", { threadId: "thread-a", turn: { id: "turn-a", status: "interrupted" } });
    expect(interrupted.store.getSession(interruptedSession.id)?.status).toBe("idle");
    interrupted.close();

    const failed = createScenario();
    failed.server.respondTo("thread/start", { thread: { id: "thread-b" } });
    failed.server.respondTo("turn/start", { turn: { id: "turn-b" } });
    const failedSession = await failed.adapter.start({ cwd: "/tmp", prompt: "work" });
    failed.server.notification("turn/completed", { threadId: "thread-b", turn: { id: "turn-b", status: "failed" } });
    expect(failed.store.getSession(failedSession.id)?.status).toBe("error");
    failed.close();
  });

  it("resumes the same Codex thread repeatedly without duplicating its durable session", async () => {
    const scenario = createScenario();
    scenario.server.respondTo("thread/resume", { thread: { id: "thread-a", name: "one" }, model: "gpt-test" });

    const first = await scenario.adapter.resumeThread("thread-a");
    const second = await scenario.adapter.resumeThread("thread-a");

    expect(second.id, scenario.server.formatTrace()).toBe(first.id);
    expect(scenario.store.listSessions()).toHaveLength(1);
    expect(scenario.server.messages("thread/resume")).toHaveLength(2);
    scenario.close();
  });

  it("rejects unsupported and ignores malformed or stale server messages with a generation trace", async () => {
    const scenario = createScenario();
    scenario.server.respondTo("thread/start", { thread: { id: "thread-a" } });
    const session = await scenario.adapter.start({ cwd: "/tmp" });
    scenario.server.serverRequest(8, "item/tool/call", { threadId: "thread-a" });
    scenario.server.malformed({ params: { threadId: "thread-a" } });
    scenario.server.notification("turn/started", { threadId: "thread-a", turn: { id: "stale" } }, 0);
    const events = await takeEvents(scenario.adapter.events(), 1);

    expect(events.find((event) => event.type === "error"), scenario.server.formatTrace()).toMatchObject({ sessionId: session.id });
    expect(scenario.server.trace.some((entry) => "error" in entry.message && entry.message.error?.code === -32601)).toBe(true);
    expect(scenario.store.getSession(session.id)?.status).toBe("idle");
    scenario.close();
  });
});

function createScenario() {
  const store = new Store(":memory:");
  const server = new FakeAppServer();
  const adapter = new AppServerAdapter(config(), store, logger(), undefined, server);
  return { adapter, server, store, close: () => { adapter.close(); store.close(); } };
}

async function takeEvents(source: AsyncIterable<CodexEvent>, count: number): Promise<CodexEvent[]> {
  const iterator = source[Symbol.asyncIterator]();
  const events: CodexEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    const result = await iterator.next();
    if (result.done) throw new Error(`event stream closed after ${events.length} event(s)`);
    events.push(result.value);
  }
  return events;
}

function config(): AppConfig {
  return {
    botToken: "token", controllerUserId: 1, allowedChatIds: new Set([1]), dbPath: ":memory:", logLevel: "silent",
    approvalTimeoutMs: 60_000, rpcTimeoutMs: 100, appServerMaxReconnectAttempts: 3, rateLimitWarnPercent: 80,
    allowSessionGrants: true, codexCommand: "codex", workspaceRoot: "/tmp"
  };
}

function logger(): never {
  return { debug() {}, warn() {}, error() {} } as never;
}
