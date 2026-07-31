import type { Store } from "../store/store.js";
import { createId } from "../utils/ids.js";

export type RuntimeLifecycle = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";
export type SubsystemState = "starting" | "running" | "degraded" | "failed" | "stopped";

export interface RuntimeFatal {
  subsystem: string;
  message: string;
  correlationId: string;
  at: number;
}

export interface SubsystemHealth {
  name: string;
  state: SubsystemState;
  startedAt?: number | undefined;
  lastHeartbeatAt?: number | undefined;
  detail?: string | undefined;
}

export interface AppServerHealth {
  state: "idle" | "connecting" | "connected" | "reconnecting" | "failed" | "stopped";
  transport?: "stdio" | "websocket" | undefined;
  pid?: number | undefined;
  connectionGeneration?: number | undefined;
  reconnectAttempt: number;
  lastMessageAt?: number | undefined;
  detail?: string | undefined;
}

export interface DeliveryHealth {
  lastSuccessAt?: number | undefined;
  lastFailureAt?: number | undefined;
  lastFailure?: string | undefined;
}

export interface RuntimeHealthSnapshot {
  overall: "healthy" | "degraded" | "unhealthy" | "stopped";
  lifecycle: RuntimeLifecycle;
  subsystems: SubsystemHealth[];
  appServer: AppServerHealth;
  lastTelegramUpdateAt?: number | undefined;
  delivery: DeliveryHealth;
  lastFatal?: RuntimeFatal | undefined;
}

export interface RuntimeHealthReporter {
  subsystem(name: string, state: SubsystemState, detail?: string): void;
  heartbeat(name: string, detail?: string): void;
  appServer(update: Partial<AppServerHealth>): void;
  telegramUpdate(at?: number): void;
  deliverySuccess(at?: number): void;
  deliveryFailure(error: unknown, at?: number): void;
  recordError(subsystem: string, error: unknown, fatal?: boolean): RuntimeFatal;
}

export class RuntimeHealth implements RuntimeHealthReporter {
  private lifecycle: RuntimeLifecycle = "idle";
  private readonly subsystemStates = new Map<string, SubsystemHealth>();
  private appServerState: AppServerHealth = { state: "idle", reconnectAttempt: 0 };
  private lastTelegramUpdateAt?: number;
  private deliveryState: DeliveryHealth = {};
  private lastFatal: RuntimeFatal | undefined;

  constructor(private readonly store?: Pick<Store, "getRuntimeValue" | "setRuntimeValue">) {
    this.lastFatal = store?.getRuntimeValue<RuntimeFatal>("runtime_last_fatal");
  }

  setLifecycle(lifecycle: RuntimeLifecycle): void {
    this.lifecycle = lifecycle;
  }

  subsystem(name: string, state: SubsystemState, detail?: string): void {
    const previous = this.subsystemStates.get(name);
    const now = Date.now();
    this.subsystemStates.set(name, {
      name,
      state,
      startedAt: previous?.startedAt ?? (state === "starting" || state === "running" ? now : undefined),
      lastHeartbeatAt: state === "running" ? now : previous?.lastHeartbeatAt,
      detail
    });
  }

  heartbeat(name: string, detail?: string): void {
    const previous = this.subsystemStates.get(name);
    this.subsystemStates.set(name, {
      name,
      state: "running",
      startedAt: previous?.startedAt ?? Date.now(),
      lastHeartbeatAt: Date.now(),
      detail: detail ?? previous?.detail
    });
  }

  appServer(update: Partial<AppServerHealth>): void {
    this.appServerState = { ...this.appServerState, ...update };
  }

  telegramUpdate(at = Date.now()): void {
    this.lastTelegramUpdateAt = at;
  }

  deliverySuccess(at = Date.now()): void {
    this.deliveryState = { ...this.deliveryState, lastSuccessAt: at };
  }

  deliveryFailure(error: unknown, at = Date.now()): void {
    this.deliveryState = {
      ...this.deliveryState,
      lastFailureAt: at,
      lastFailure: errorMessage(error)
    };
  }

  recordError(subsystem: string, error: unknown, fatal = false): RuntimeFatal {
    const value: RuntimeFatal = {
      subsystem,
      message: errorMessage(error),
      correlationId: createId("error"),
      at: Date.now()
    };
    if (fatal) {
      this.lastFatal = value;
      try {
        this.store?.setRuntimeValue("runtime_last_fatal", value);
      } catch {
        // Keep the in-memory fatal usable even when SQLite is the failed subsystem.
      }
      this.subsystem(subsystem, "failed", value.message);
      this.lifecycle = "failed";
    }
    return value;
  }

  snapshot(): RuntimeHealthSnapshot {
    const subsystems = [...this.subsystemStates.values()].sort((left, right) => left.name.localeCompare(right.name));
    const criticalUnhealthy = subsystems.some((item) => item.state !== "running");
    const deliveryDegraded = Boolean(
      this.deliveryState.lastFailureAt &&
      (!this.deliveryState.lastSuccessAt || this.deliveryState.lastFailureAt > this.deliveryState.lastSuccessAt)
    );
    const overall = this.lifecycle === "stopped" || this.lifecycle === "idle"
      ? "stopped"
      : this.lifecycle === "failed" || criticalUnhealthy || this.appServerState.state === "failed" || this.appServerState.state === "stopped"
        ? "unhealthy"
        : this.lifecycle !== "running" || this.appServerState.state !== "connected" || deliveryDegraded
          ? "degraded"
          : "healthy";
    return {
      overall,
      lifecycle: this.lifecycle,
      subsystems: subsystems.map((item) => ({ ...item })),
      appServer: { ...this.appServerState },
      lastTelegramUpdateAt: this.lastTelegramUpdateAt,
      delivery: { ...this.deliveryState },
      lastFatal: this.lastFatal ? { ...this.lastFatal } : undefined
    };
  }
}

export const noopRuntimeHealth: RuntimeHealthReporter = {
  subsystem() {},
  heartbeat() {},
  appServer() {},
  telegramUpdate() {},
  deliverySuccess() {},
  deliveryFailure() {},
  recordError(subsystem, error) {
    return { subsystem, message: errorMessage(error), correlationId: createId("error"), at: Date.now() };
  }
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
