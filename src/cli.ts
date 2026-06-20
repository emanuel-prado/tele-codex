#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { AppServerAdapter } from "./adapters/app-server-adapter.js";
import { PtyAdapter } from "./adapters/pty-adapter.js";
import { PolicyEngine } from "./security/policy.js";
import { Store } from "./store/store.js";
import { TelegramGateway } from "./telegram/gateway.js";
import { createLogger } from "./runtime/logger.js";
import { SessionManager } from "./runtime/session-manager.js";
import { loadDotEnv } from "./runtime/dotenv.js";
import { formatDoctorReport, runDoctor } from "./runtime/doctor.js";
import { ServiceManager } from "./runtime/service-manager.js";

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
  const appserver = new AppServerAdapter(config, store, logger);
  const pty = new PtyAdapter(config, store, logger);
  const sessions = new SessionManager({ appserver, pty }, store, config.defaultAdapter, logger);
  const policy = new PolicyEngine(config);
  const telegram = new TelegramGateway(config, sessions, store, policy, logger);

  const shutdown = async () => {
    logger.info("shutting down");
    await telegram.stop();
    await sessions.close();
    store.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

  await telegram.start();
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
  throw new Error("Usage: tele-codex service install|status|uninstall [--env-file PATH]");
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
