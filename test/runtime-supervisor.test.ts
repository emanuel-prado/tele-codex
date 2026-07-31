import { describe, expect, it } from "vitest";
import { RuntimeHealth } from "../src/runtime/health.js";
import { RuntimeFailure, RuntimeSupervisor, type SupervisedSubsystem } from "../src/runtime/supervisor.js";
import { Store } from "../src/store/store.js";

describe("RuntimeSupervisor", () => {
  it("turns unexpected critical-loop death into a fatal exit after reverse-order cleanup", async () => {
    const cleanup: string[] = [];
    const first = deferred<void>();
    const second = deferred<void>();
    const supervisor = new RuntimeSupervisor(new RuntimeHealth(), logger());
    await supervisor.start([
      subsystem("first", first.promise, cleanup),
      subsystem("second", second.promise, cleanup)
    ]);

    second.reject(new Error("worker crashed"));

    await expect(supervisor.wait()).rejects.toMatchObject({
      name: "RuntimeFailure",
      fatal: expect.objectContaining({ subsystem: "second", message: "worker crashed" })
    });
    expect(cleanup).toEqual(["second", "first"]);
    const snapshot = supervisor.health.snapshot();
    expect(snapshot.overall).toBe("unhealthy");
    expect(snapshot.lastFatal?.correlationId).toMatch(/^error_/);
  });

  it("treats an unexpected normal loop exit as fatal", async () => {
    const loop = deferred<void>();
    const supervisor = new RuntimeSupervisor(new RuntimeHealth(), logger());
    await supervisor.start([subsystem("event-forwarder", loop.promise, [])]);

    loop.resolve();

    await expect(supervisor.wait()).rejects.toThrow(/Critical subsystem exited unexpectedly/);
  });

  it("cleans every started subsystem exactly once when startup rejects", async () => {
    const cleanup: string[] = [];
    const supervisor = new RuntimeSupervisor(new RuntimeHealth(), logger());
    const running = deferred<void>();
    const broken: SupervisedSubsystem = {
      name: "telegram-polling",
      async start() { throw new Error("startup rejected"); },
      wait: () => Promise.resolve(),
      stop() { cleanup.push("telegram-polling"); }
    };

    await expect(supervisor.start([subsystem("app-server", running.promise, cleanup), broken])).rejects.toBeInstanceOf(RuntimeFailure);
    await supervisor.stop();
    expect(cleanup).toEqual(["telegram-polling", "app-server"]);
  });

  it("stops gracefully and idempotently without reporting a fatal error", async () => {
    const cleanup: string[] = [];
    const loop = deferred<void>();
    const supervisor = new RuntimeSupervisor(new RuntimeHealth(), logger());
    await supervisor.start([subsystem("worker", loop.promise, cleanup, () => loop.resolve())]);

    await Promise.all([supervisor.stop(), supervisor.stop()]);
    await expect(supervisor.wait()).resolves.toBeUndefined();
    expect(cleanup).toEqual(["worker"]);
    expect(supervisor.health.snapshot()).toMatchObject({ overall: "stopped", lifecycle: "stopped", lastFatal: undefined });
  });

  it("treats a signal during startup as graceful shutdown", async () => {
    const startup = deferred<void>();
    const waiting = deferred<void>();
    const cleanup: string[] = [];
    const supervisor = new RuntimeSupervisor(new RuntimeHealth(), logger());
    const starting = supervisor.start([{
      name: "app-server",
      start: () => startup.promise,
      wait: () => waiting.promise,
      stop() {
        cleanup.push("app-server");
        startup.resolve();
        waiting.resolve();
      }
    }]);

    await supervisor.stop();
    await starting;
    await expect(supervisor.wait()).resolves.toBeUndefined();
    expect(cleanup).toEqual(["app-server"]);
    expect(supervisor.health.snapshot().lastFatal).toBeUndefined();
  });
});

describe("RuntimeHealth", () => {
  it("cannot report healthy while the app-server control path is disconnected", () => {
    const health = new RuntimeHealth();
    health.setLifecycle("running");
    health.subsystem("telegram-polling", "running");
    health.subsystem("event-forwarder", "running");
    health.appServer({ state: "reconnecting", reconnectAttempt: 2 });

    expect(health.snapshot().overall).toBe("degraded");

    health.appServer({ state: "connected", connectionGeneration: 3, reconnectAttempt: 0 });
    expect(health.snapshot().overall).toBe("healthy");

    health.deliveryFailure(new Error("Telegram unavailable"), 10);
    expect(health.snapshot().overall).toBe("degraded");
    health.deliverySuccess(11);
    expect(health.snapshot().overall).toBe("healthy");
  });

  it("persists the last fatal correlation for restart diagnostics", () => {
    const store = new Store(":memory:");
    const health = new RuntimeHealth(store);
    const fatal = health.recordError("outbox-worker", new Error("database unavailable"), true);

    expect(new RuntimeHealth(store).snapshot().lastFatal).toEqual(fatal);
    store.close();
  });
});

function subsystem(
  name: string,
  wait: Promise<void>,
  cleanup: string[],
  onStop?: () => void
): SupervisedSubsystem {
  return {
    name,
    start() {},
    wait: () => wait,
    stop() {
      cleanup.push(name);
      onStop?.();
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function logger(): never {
  return { fatal() {}, error() {} } as never;
}
