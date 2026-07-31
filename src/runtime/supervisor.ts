import type { Logger } from "pino";
import { RuntimeHealth, type RuntimeFatal } from "./health.js";

export interface SupervisedSubsystem {
  name: string;
  start(): void | Promise<void>;
  wait(): Promise<void>;
  stop(): void | Promise<void>;
}

export class RuntimeFailure extends Error {
  constructor(readonly fatal: RuntimeFatal) {
    super(`${fatal.subsystem} failed (${fatal.correlationId}): ${fatal.message}`);
    this.name = "RuntimeFailure";
  }
}

export class RuntimeSupervisor {
  private phase: "idle" | "starting" | "running" | "stopping" | "stopped" | "failed" = "idle";
  private started: SupervisedSubsystem[] = [];
  private stopPromise?: Promise<void>;
  private failure?: RuntimeFailure;
  private resolveWait!: () => void;
  private rejectWait!: (error: RuntimeFailure) => void;
  private readonly waitPromise = new Promise<void>((resolve, reject) => {
    this.resolveWait = resolve;
    this.rejectWait = reject;
  });

  constructor(
    readonly health: RuntimeHealth,
    private readonly logger: Logger
  ) {}

  async start(subsystems: SupervisedSubsystem[]): Promise<void> {
    if (this.phase === "running") return;
    if (this.phase !== "idle") throw new Error(`Runtime supervisor cannot start while ${this.phase}.`);
    this.phase = "starting";
    this.health.setLifecycle("starting");
    try {
      for (const subsystem of subsystems) {
        this.started.push(subsystem);
        this.health.subsystem(subsystem.name, "starting");
        await subsystem.start();
        if (this.isStopping()) return;
        if (this.failure) throw this.failure;
        this.health.subsystem(subsystem.name, "running");
        void this.monitor(subsystem);
      }
      this.phase = "running";
      this.health.setLifecycle("running");
    } catch (error) {
      if (this.isStopping()) {
        await this.stop();
        return;
      }
      if (error instanceof RuntimeFailure) throw error;
      const failure = this.recordFailure(this.started.at(-1)?.name ?? "runtime-startup", error);
      await this.stop();
      throw failure;
    }
  }

  wait(): Promise<void> {
    return this.waitPromise;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStop();
    return this.stopPromise;
  }

  private async monitor(subsystem: SupervisedSubsystem): Promise<void> {
    try {
      await subsystem.wait();
      if (this.phase === "starting" || this.phase === "running") {
        const failure = this.recordFailure(subsystem.name, new Error("Critical subsystem exited unexpectedly."));
        await this.stopAfterFailure(failure);
      }
    } catch (error) {
      if (this.phase === "starting" || this.phase === "running") {
        const failure = this.recordFailure(subsystem.name, error);
        await this.stopAfterFailure(failure);
      }
    }
  }

  private isStopping(): boolean {
    return this.phase === "stopping" || this.phase === "stopped";
  }

  private recordFailure(subsystem: string, error: unknown): RuntimeFailure {
    if (this.failure) return this.failure;
    const fatal = this.health.recordError(subsystem, error, true);
    this.failure = new RuntimeFailure(fatal);
    this.phase = "failed";
    this.logger.fatal({ subsystem, correlationId: fatal.correlationId, error: fatal.message }, "critical runtime subsystem failed");
    return this.failure;
  }

  private async stopAfterFailure(failure: RuntimeFailure): Promise<void> {
    await this.stop();
    this.rejectWait(failure);
  }

  private async performStop(): Promise<void> {
    const failed = Boolean(this.failure);
    this.phase = "stopping";
    if (!failed) this.health.setLifecycle("stopping");
    const errors: Array<{ subsystem: string; error: unknown }> = [];
    for (const subsystem of [...this.started].reverse()) {
      try {
        await subsystem.stop();
        this.health.subsystem(subsystem.name, "stopped");
      } catch (error) {
        errors.push({ subsystem: subsystem.name, error });
        this.logger.error({ subsystem: subsystem.name, error }, "runtime subsystem cleanup failed");
      }
    }
    this.started = [];
    if (errors.length > 0 && !this.failure) {
      this.recordFailure("runtime-shutdown", new AggregateError(errors.map((item) => item.error), "Runtime cleanup failed."));
    }
    if (this.failure) {
      this.phase = "failed";
      this.health.setLifecycle("failed");
      if (!failed) this.rejectWait(this.failure);
    } else {
      this.phase = "stopped";
      this.health.setLifecycle("stopped");
      this.resolveWait();
    }
  }
}
