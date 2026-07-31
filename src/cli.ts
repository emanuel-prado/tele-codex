#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { AppServerAdapter } from "./adapters/app-server-adapter.js";
import { LegacyTmuxBridge } from "./legacy/legacy-tmux-bridge.js";
import { PolicyEngine } from "./security/policy.js";
import { Store } from "./store/store.js";
import { TelegramGateway } from "./telegram/gateway.js";
import { createLogger } from "./runtime/logger.js";
import { SessionManager } from "./runtime/session-manager.js";
import { loadDotEnv } from "./runtime/dotenv.js";
import { formatDoctorReport, runDoctor } from "./runtime/doctor.js";
import { ServiceManager } from "./runtime/service-manager.js";
import { RuntimeHealth } from "./runtime/health.js";
import { RuntimeSupervisor, type SupervisedSubsystem } from "./runtime/supervisor.js";

async function main(): Promise<void> {
  const envFile = optionValue("--env-file") ?? process.env.TELE_CODEX_ENV_FILE ?? ".env";
  loadDotEnv(envFile);
  if (process.argv[2] === "service") {
    await runServiceCommand(envFile);
    return;
  }
  const config = loadConfig();
  if (process.argv[2] === "doctor") {
    const report = await runDoctor(config);
    console.log(formatDoctorReport(report));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  const logger = createLogger(config.logLevel);
  const store = new Store(config.dbPath);
  try {
    const health = new RuntimeHealth(store);
    const supervisor = new RuntimeSupervisor(health, logger);
    const appserver = new AppServerAdapter(config, store, logger, health);
    const sessions = new SessionManager(appserver, store, logger);
    const legacyTmux = new LegacyTmuxBridge(config, store, logger);
    const policy = new PolicyEngine(config);
    const telegram = new TelegramGateway(config, sessions, legacyTmux, store, policy, logger, health);

    const storeSubsystem = cleanupSubsystem("sqlite-store", () => store.close());
    const appServerSubsystem: SupervisedSubsystem = {
      name: "app-server-transport",
      start: () => appserver.startTransport(),
      wait: () => appserver.waitForFailure(),
      stop: () => sessions.close()
    };
    const [telegramPolling, telegramEvents, outboxWorker, actionSweeper] = telegram.runtimeSubsystems();
    if (!telegramPolling || !telegramEvents || !outboxWorker || !actionSweeper) {
      throw new Error("Telegram runtime subsystem registry is incomplete.");
    }
    const subsystems = [
      storeSubsystem,
      appServerSubsystem,
      telegramEvents,
      outboxWorker,
      actionSweeper,
      sessions.eventSubsystem(),
      telegramPolling
    ];
    const shutdown = () => {
      logger.info("shutting down");
      void supervisor.stop().catch((error) => logger.error({ error }, "runtime shutdown failed"));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    try {
      await supervisor.start(subsystems);
      await supervisor.wait();
    } finally {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
      await supervisor.stop();
    }
  } catch (error) {
    store.close();
    throw error;
  }
}

async function runServiceCommand(envFile: string): Promise<void> {
  const manager = new ServiceManager();
  const action = process.argv[3] ?? "status";
  if (action === "install") {
    const status = await manager.install(envFile);
    console.log(formatServiceStatus(status));
    return;
  }
  if (action === "uninstall") {
    await manager.uninstall();
    console.log("tele-codex service uninstalled.");
    return;
  }
  if (action === "status") {
    console.log(formatServiceStatus(await manager.status()));
    return;
  }
  if (action === "update") {
    console.log(formatServiceStatus(await manager.update()));
    return;
  }
  throw new Error("Usage: tele-codex service install|status|update|uninstall [--env-file PATH]");
}

function cleanupSubsystem(name: string, cleanup: () => void | Promise<void>): SupervisedSubsystem {
  let resolve!: () => void;
  const stopped = new Promise<void>((done) => {
    resolve = done;
  });
  let stopPromise: Promise<void> | undefined;
  return {
    name,
    start() {},
    wait: () => stopped,
    stop() {
      if (!stopPromise) {
        stopPromise = Promise.resolve().then(cleanup).finally(resolve);
      }
      return stopPromise;
    }
  };
}

function formatServiceStatus(status: Awaited<ReturnType<ServiceManager["status"]>>): string {
  return [
    "tele-codex service",
    `installed: ${status.installed}`,
    `enabled: ${status.enabled}`,
    `active: ${status.active}`,
    `linger: ${status.linger}`,
    status.detail
  ].join("\n");
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
