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
  TELE_CODEX_ALLOW_SESSION_GRANTS: z
    .enum(["true", "false"])
    .optional()
    .default("true")
    .transform((value) => value === "true"),
  TELE_CODEX_CODEX_COMMAND: z.string().optional().default("codex"),
  TELE_CODEX_TMUX_SUBMIT_KEY: z.string().optional().default("enter"),
  TELE_CODEX_TMUX_PASTE_SETTLE_MS: z.coerce.number().int().nonnegative().optional().default(250),
  TELE_CODEX_WORKSPACE_ROOT: z.string().optional().default("~/Workspace"),
  TELE_CODEX_APP_SERVER_URL: z.string().optional()
});

export interface AppConfig {
  botToken: string;
  allowedUserIds: Set<number>;
  allowedChatIds: Set<number>;
  dbPath: string;
  logLevel: string;
  approvalTimeoutMs: number;
  rpcTimeoutMs: number;
  appServerMaxReconnectAttempts: number;
  rateLimitWarnPercent: number;
  allowSessionGrants: boolean;
  codexCommand: string;
  tmuxSubmitKey: string;
  tmuxPasteSettleMs: number;
  workspaceRoot: string;
  appServerUrl?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const dbPath = resolve(parsed.TELE_CODEX_DB_PATH);
  mkdirSync(dirname(dbPath), { recursive: true });

  const config: AppConfig = {
    botToken: parsed.TELE_CODEX_BOT_TOKEN,
    allowedUserIds: parseNumberSet(parsed.TELE_CODEX_ALLOWED_USER_IDS),
    allowedChatIds: parseNumberSet(parsed.TELE_CODEX_ALLOWED_CHAT_IDS),
    dbPath,
    logLevel: parsed.TELE_CODEX_LOG_LEVEL,
    approvalTimeoutMs: parsed.TELE_CODEX_APPROVAL_TIMEOUT_MS,
    rpcTimeoutMs: parsed.TELE_CODEX_RPC_TIMEOUT_MS,
    appServerMaxReconnectAttempts: parsed.TELE_CODEX_APP_SERVER_MAX_RECONNECT_ATTEMPTS,
    rateLimitWarnPercent: parsed.TELE_CODEX_RATE_LIMIT_WARN_PERCENT,
    allowSessionGrants: parsed.TELE_CODEX_ALLOW_SESSION_GRANTS,
    codexCommand: parsed.TELE_CODEX_CODEX_COMMAND,
    tmuxSubmitKey: parsed.TELE_CODEX_TMUX_SUBMIT_KEY,
    tmuxPasteSettleMs: parsed.TELE_CODEX_TMUX_PASTE_SETTLE_MS,
    workspaceRoot: resolveHome(parsed.TELE_CODEX_WORKSPACE_ROOT)
  };
  if (parsed.TELE_CODEX_APP_SERVER_URL) config.appServerUrl = parsed.TELE_CODEX_APP_SERVER_URL;
  return config;
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
