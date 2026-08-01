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

    const events = await takeEvents(scenario.adapter.events(), 5);
    expect(events.map((event) => event.type), scenario.server.formatTrace()).toEqual([
      "statusChanged", "statusChanged", "agentMessage", "taskCompleted", "approvalRequested"
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
    const approval = (await takeEvents(scenario.adapter.events(), 2)).find(
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
    const events = await takeEvents(scenario.adapter.events(), 3);

    expect(events.find((event) => event.type === "agentMessage"), scenario.server.formatTrace()).toMatchObject({ sessionId: second.id, text: "only b" });
    expect(scenario.server.messages("turn/interrupt")).toHaveLength(1);
    expect(scenario.server.messages("thread/archive")).toHaveLength(1);
    expect(scenario.store.getSession(first.id)?.status).toBe("detached");
    expect(scenario.store.getSession(second.id)?.status).toBe("archived");
    scenario.close();
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
    const events = await takeEvents(scenario.adapter.events(), 2);

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
    botToken: "token", allowedUserIds: new Set([1]), allowedChatIds: new Set([1]), dbPath: ":memory:", logLevel: "silent",
    approvalTimeoutMs: 60_000, rpcTimeoutMs: 100, appServerMaxReconnectAttempts: 3, rateLimitWarnPercent: 80,
    allowSessionGrants: true, codexCommand: "codex", tmuxSubmitKey: "enter", tmuxPasteSettleMs: 0, workspaceRoot: "/tmp"
  };
}

function logger(): never {
  return { debug() {}, warn() {}, error() {} } as never;
}
