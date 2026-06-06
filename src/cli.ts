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

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const store = new Store(config.dbPath);
  const appserver = new AppServerAdapter(config, store, logger);
  const pty = new PtyAdapter(config, store, logger);
  const sessions = new SessionManager({ appserver, pty }, store, config.defaultAdapter, logger);
  const policy = new PolicyEngine(config);
  const telegram = new TelegramGateway(config, sessions, store, policy, logger);

  process.once("SIGINT", () => {
    logger.info("shutting down");
    store.close();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    logger.info("shutting down");
    store.close();
    process.exit(0);
  });

  await telegram.start();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
