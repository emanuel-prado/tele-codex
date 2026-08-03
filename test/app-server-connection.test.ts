import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServerAdapter } from "../src/adapters/app-server-adapter.js";
import type { AppConfig } from "../src/config.js";
import { Store } from "../src/store/store.js";
import type { PendingAction } from "../src/types/events.js";
import { RuntimeHealth } from "../src/runtime/health.js";
import { RuntimeSupervisor } from "../src/runtime/supervisor.js";
import { FakeAppServer } from "./support/fake-app-server.js";

type AdapterInternals = {
  connected: boolean;
  connectionGeneration?: number;
  sessionsByThread: Map<string, { sessionId: string; generation: number }>;
  handleMessage(message: Record<string, unknown>, generation: number): Promise<void>;
  handleDisconnect(generation: number): void;
  ensureConnected(): Promise<void>;
  reconnectAttempt: number;
  reconnectTimer?: NodeJS.Timeout;
  waitForFailure(): Promise<void>;
};

afterEach(() => vi.useRealTimers());

describe("AppServerAdapter connection generations", () => {
  it("invalidates persisted attachments and requests on restart", () => {
    const store = new Store(":memory:");
    store.upsertSession({
      id: "session_1",
      adapter: "appserver",
      label: "one",
      codexThreadId: "thread_1",
      connectionGeneration: 4
    }, "idle");
    store.putPendingAction(action(4));

    const adapter = new AppServerAdapter(config(), store, logger());

    expect(store.getSession("session_1")).toMatchObject({ status: "detached" });
    expect(store.getSession("session_1")?.connectionGeneration).toBeUndefined();
    expect(store.getPendingAction("action_1")?.status).toBe("orphaned");
    expect(store.getRuntimeValue("startup_orphaned_action_ids")).toEqual(["action_1"]);
    adapter.close();
    store.close();
  });

  it("ignores stale requests and resolves only an acknowledgement from the owning generation", async () => {
    const store = new Store(":memory:");
    const adapter = new AppServerAdapter(config(), store, logger());
    const internals = adapter as unknown as AdapterInternals;
    attach(internals, store, 2);

    await internals.handleMessage(approvalRequest(7), 1);
    expect(store.listPendingActions()).toEqual([]);

    await internals.handleMessage(approvalRequest(7), 2);
    const [action] = store.listPendingActions();
    expect(action).toMatchObject({ requestId: 7, connectionGeneration: 2, status: "pending" });
    store.claimPendingAction(action!.id);

    await internals.handleMessage({ method: "serverRequest/resolved", params: { requestId: 7 } }, 1);
    expect(store.getPendingAction(action!.id)?.status).toBe("submitting");
    await internals.handleMessage({ method: "serverRequest/resolved", params: { requestId: 7 } }, 2);
    expect(store.getPendingAction(action!.id)?.status).toBe("resolved");

    adapter.close();
    store.close();
  });

  it("does not let an old close event tear down a newer attachment", () => {
    const store = new Store(":memory:");
    const adapter = new AppServerAdapter(config(), store, logger());
    const internals = adapter as unknown as AdapterInternals;
    attach(internals, store, 2);
    store.putPendingAction(action(2));

    internals.handleDisconnect(1);

    expect(store.getSession("session_1")).toMatchObject({ status: "idle", connectionGeneration: 2 });
    expect(store.getPendingAction("action_1")?.status).toBe("pending");
    expect(internals.sessionsByThread.get("thread_1")?.generation).toBe(2);
    adapter.close();
    store.close();
  });

  it("orphans and detaches only state owned by the lost generation", () => {
    const store = new Store(":memory:");
    const adapter = new AppServerAdapter(config(), store, logger());
    const internals = adapter as unknown as AdapterInternals;
    attach(internals, store, 2);
    store.putPendingAction(action(2));
    store.claimPendingAction("action_1");
    store.putPendingAction({ ...action(1), id: "older_action", requestId: 8 });

    internals.handleDisconnect(2);

    expect(store.getPendingAction("action_1")?.status).toBe("orphaned");
    expect(store.getPendingAction("older_action")?.status).toBe("pending");
    expect(store.getSession("session_1")).toMatchObject({ status: "detached" });
    expect(store.getSession("session_1")?.connectionGeneration).toBeUndefined();
    expect(internals.sessionsByThread.has("thread_1")).toBe(false);
    adapter.close();
    store.close();
  });

  it("fails the supervised transport after reconnect attempts are exhausted", async () => {
    vi.useFakeTimers();
    const store = new Store(":memory:");
    const health = new RuntimeHealth();
    const adapter = new AppServerAdapter({ ...config(), appServerMaxReconnectAttempts: 2 }, store, logger(), health);
    const internals = adapter as unknown as AdapterInternals;
    attach(internals, store, 2);
    internals.ensureConnected = async () => { throw new Error("offline"); };

    internals.handleDisconnect(2);
    const failure = expect(internals.waitForFailure()).rejects.toThrow(/reconnect exhausted after 2 attempts/i);
    await vi.advanceTimersByTimeAsync(3_000);

    await failure;
    expect(health.snapshot().appServer).toMatchObject({ state: "failed", reconnectAttempt: 2 });
    adapter.close();
    store.close();
  });

  it("recovers before the reconnect budget is exhausted", async () => {
    vi.useFakeTimers();
    const store = new Store(":memory:");
    const health = new RuntimeHealth();
    const adapter = new AppServerAdapter(config(), store, logger(), health);
    const internals = adapter as unknown as AdapterInternals;
    attach(internals, store, 2);
    let attempts = 0;
    internals.ensureConnected = async () => {
      attempts += 1;
      internals.connected = true;
      internals.reconnectAttempt = 0;
      health.appServer({ state: "connected", connectionGeneration: 3, reconnectAttempt: 0 });
    };

    internals.handleDisconnect(2);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(attempts).toBe(1);
    expect(health.snapshot().appServer).toMatchObject({ state: "connected", reconnectAttempt: 0 });
    expect(internals.reconnectTimer).toBeUndefined();
    adapter.close();
    await expect(internals.waitForFailure()).resolves.toBeUndefined();
    store.close();
  });

  it("publishes a connection generation only after initialize and initialized both succeed", async () => {
    const store = new Store(":memory:");
    const server = new FakeAppServer();
    let adapter!: AppServerAdapter;
    server.respondTo("initialize", (_params: unknown, generation: number) => {
      const internals = adapter as unknown as AdapterInternals;
      expect(generation).toBe(1);
      expect(internals.connectionGeneration).toBeUndefined();
      expect(internals.connected).toBe(false);
      server.emit("message", approvalRequest(9), generation);
      return { userAgent: "fake" };
    });
    adapter = new AppServerAdapter(config(), store, logger(), undefined, server);

    await adapter.startTransport();

    const internals = adapter as unknown as AdapterInternals;
    expect(internals.connectionGeneration).toBe(1);
    expect(internals.connected).toBe(true);
    expect(store.listPendingActions()).toEqual([]);
    expect(server.messages("initialized")).toHaveLength(1);
    adapter.close();
    store.close();
  });

  it.each(["initialize", "initialized"] as const)(
    "closes a half-open transport when %s fails and reconnects under supervision",
    async (stage) => {
      vi.useFakeTimers();
      const store = new Store(":memory:");
      const server = new FakeAppServer();
      const health = new RuntimeHealth();
      let initializeAttempts = 0;
      server.respondTo("initialize", () => {
        initializeAttempts += 1;
        if (stage === "initialize" && initializeAttempts === 1) throw new Error("initialization timed out");
        return { userAgent: "fake" };
      });
      if (stage === "initialized") server.failNotification("initialized", new Error("initialized write failed"));
      const adapter = new AppServerAdapter(config(), store, logger(), health, server);

      await expect(adapter.startTransport()).resolves.toBeUndefined();
      expect(health.snapshot().appServer).toMatchObject({ state: "reconnecting", reconnectAttempt: 1 });
      expect((adapter as unknown as AdapterInternals).connectionGeneration).toBeUndefined();
      expect(server.trace.some((entry) => entry.direction === "close" && entry.generation === 1)).toBe(true);

      if (stage === "initialized") server.clearNotificationFailure("initialized");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(health.snapshot().appServer).toMatchObject({ state: "connected", connectionGeneration: 2 });
      adapter.close();
      store.close();
    }
  );

  it("turns repeated startup initialization failure into one supervised runtime rejection", async () => {
    vi.useFakeTimers();
    const store = new Store(":memory:");
    const server = new FakeAppServer();
    const health = new RuntimeHealth();
    server.respondTo("initialize", () => { throw new Error("initialization rejected"); });
    const adapter = new AppServerAdapter({ ...config(), appServerMaxReconnectAttempts: 1 }, store, logger(), health, server);
    const supervisor = new RuntimeSupervisor(health, logger());

    await supervisor.start([{
      name: "app-server-transport",
      start: () => adapter.startTransport(),
      wait: () => adapter.waitForFailure(),
      stop: () => adapter.close()
    }]);
    const failure = expect(supervisor.wait()).rejects.toThrow(/app-server-transport failed.*reconnect exhausted/i);
    await vi.advanceTimersByTimeAsync(1_000);

    await failure;
    expect(health.snapshot().appServer).toMatchObject({ state: "failed", reconnectAttempt: 1 });
    store.close();
  });
});

function attach(internals: AdapterInternals, store: Store, generation: number): void {
  internals.connected = true;
  internals.connectionGeneration = generation;
  internals.sessionsByThread.set("thread_1", { sessionId: "session_1", generation });
  store.upsertSession({
    id: "session_1",
    adapter: "appserver",
    label: "one",
    codexThreadId: "thread_1",
    connectionGeneration: generation
  }, "idle");
}

function approvalRequest(id: number): Record<string, unknown> {
  return {
    id,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread_1", command: "true" }
  };
}

function action(connectionGeneration: number): PendingAction {
  return {
    id: "action_1",
    kind: "commandApproval",
    sessionId: "session_1",
    requestId: 7,
    connectionGeneration,
    threadId: "thread_1",
    title: "Approval",
    body: "run",
    payload: { method: "item/commandExecution/requestApproval", params: {} },
    expiresAt: Date.now() + 60_000
  };
}

function config(): AppConfig {
  return {
    botToken: "token",
    controllerUserId: 1,
    allowedChatIds: new Set([1]),
    dbPath: ":memory:",
    logLevel: "silent",
    approvalTimeoutMs: 60_000,
    rpcTimeoutMs: 100,
    appServerMaxReconnectAttempts: 3,
    rateLimitWarnPercent: 80,
    allowSessionGrants: true,
    codexCommand: "codex",
    tmuxSubmitKey: "enter",
    tmuxPasteSettleMs: 0,
    workspaceRoot: "/tmp"
  };
}

function logger(): never {
  return { debug() {}, warn() {}, error() {}, fatal() {} } as never;
}
