import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
const envSchema = z.object({
  TELE_CODEX_BOT_TOKEN: z.string().min(1),
  TELE_CODEX_ALLOWED_USER_IDS: z.string().min(1),
  TELE_CODEX_ALLOWED_CHAT_IDS: z.string().optional().default(""),
  TELE_CODEX_DB_PATH: z.string().optional().default(".tele-codex/tele-codex.db"),
  TELE_CODEX_LOG_LEVEL: z.string().optional().default("info"),
  TELE_CODEX_APPROVAL_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(900_000),
  TELE_CODEX_RPC_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(30_000),
  TELE_CODEX_APP_SERVER_MAX_RECONNECT_ATTEMPTS: z.coerce.number().int().positive().optional().default(8),
  TELE_CODEX_RATE_LIMIT_WARN_PERCENT: z.coerce.number().min(1).max(100).optional().default(80),
  TELE_CODEX_TRANSCRIPT_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
  TELE_CODEX_ALLOW_SESSION_GRANTS: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((value) => value === "true"),
  TELE_CODEX_CODEX_COMMAND: z.string().optional().default("codex"),
  TELE_CODEX_WORKSPACE_ROOT: z.string().optional().default("~/Workspace"),
  TELE_CODEX_APP_SERVER_URL: z.string().optional()
});

export interface AppConfig {
  botToken: string;
  controllerUserId: number;
  allowedChatIds: Set<number>;
  dbPath: string;
  logLevel: string;
  approvalTimeoutMs: number;
  rpcTimeoutMs: number;
  appServerMaxReconnectAttempts: number;
  rateLimitWarnPercent: number;
  transcriptRetentionDays?: number;
  allowSessionGrants: boolean;
  codexCommand: string;
  workspaceRoot: string;
  appServerUrl?: string;
}

export interface ConfigInspection {
  config?: AppConfig;
  botTokenConfigured: boolean;
  controllerCount?: number;
  errors: string[];
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { createDatabaseDirectory?: boolean } = {}
): AppConfig {
  const parsed = envSchema.parse(env);
  const controllerIds = parseNumberSet(parsed.TELE_CODEX_ALLOWED_USER_IDS);
  if (controllerIds.size !== 1) {
    throw new Error("TELE_CODEX_ALLOWED_USER_IDS must contain exactly one numeric Controller ID.");
  }
  const dbPath = resolve(parsed.TELE_CODEX_DB_PATH);
  if (options.createDatabaseDirectory !== false) mkdirSync(dirname(dbPath), { recursive: true });

  const config: AppConfig = {
    botToken: parsed.TELE_CODEX_BOT_TOKEN,
    controllerUserId: [...controllerIds][0]!,
    allowedChatIds: parseNumberSet(parsed.TELE_CODEX_ALLOWED_CHAT_IDS),
    dbPath,
    logLevel: parsed.TELE_CODEX_LOG_LEVEL,
    approvalTimeoutMs: parsed.TELE_CODEX_APPROVAL_TIMEOUT_MS,
    rpcTimeoutMs: parsed.TELE_CODEX_RPC_TIMEOUT_MS,
    appServerMaxReconnectAttempts: parsed.TELE_CODEX_APP_SERVER_MAX_RECONNECT_ATTEMPTS,
    rateLimitWarnPercent: parsed.TELE_CODEX_RATE_LIMIT_WARN_PERCENT,
    allowSessionGrants: parsed.TELE_CODEX_ALLOW_SESSION_GRANTS,
    codexCommand: parsed.TELE_CODEX_CODEX_COMMAND,
    workspaceRoot: resolveHome(parsed.TELE_CODEX_WORKSPACE_ROOT)
  };
  if (parsed.TELE_CODEX_TRANSCRIPT_RETENTION_DAYS !== undefined) {
    config.transcriptRetentionDays = parsed.TELE_CODEX_TRANSCRIPT_RETENTION_DAYS;
  }
  if (parsed.TELE_CODEX_APP_SERVER_URL) config.appServerUrl = parsed.TELE_CODEX_APP_SERVER_URL;
  return config;
}

export function inspectConfig(env: NodeJS.ProcessEnv = process.env): ConfigInspection {
  const rawToken = env.TELE_CODEX_BOT_TOKEN?.trim() ?? "";
  let controllerCount: number | undefined;
  const errors: string[] = [];
  try {
    controllerCount = parseNumberSet(env.TELE_CODEX_ALLOWED_USER_IDS ?? "").size;
  } catch (error) {
    errors.push(errorMessage(error));
  }
  try {
    return {
      config: loadConfig(env, { createDatabaseDirectory: false }),
      botTokenConfigured: Boolean(rawToken && !rawToken.includes("replace-")),
      ...(controllerCount === undefined ? {} : { controllerCount }),
      errors
    };
  } catch (error) {
    const message = errorMessage(error);
    if (!errors.includes(message)) errors.push(message);
    return {
      botTokenConfigured: Boolean(rawToken && !rawToken.includes("replace-")),
      ...(controllerCount === undefined ? {} : { controllerCount }),
      errors
    };
  }
}

function resolveHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

function parseNumberSet(raw: string): Set<number> {
  const values = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part));
  if (values.some((value) => !Number.isSafeInteger(value))) {
    throw new Error(`Expected comma-separated numeric Telegram IDs, got: ${raw}`);
  }
  return new Set(values);
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`).join("; ");
  }
  return error instanceof Error ? error.message : "Invalid configuration.";
}
