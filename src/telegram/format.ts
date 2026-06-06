import type { PendingAction } from "../types/events.js";
import type { SessionTokenUsage } from "../types/control.js";
import type { StoredSession } from "../store/store.js";

const TELEGRAM_TEXT_LIMIT = 4096;
const DEFAULT_MESSAGE_BUDGET = 3900;

export function formatAction(action: PendingAction): string {
  return truncateMiddle(`*${escapeMd(actionTitle(action))}*\n\n${escapeMd(actionBody(action))}`, DEFAULT_MESSAGE_BUDGET);
}

export function formatSessions(sessions: StoredSession[]): string {
  if (sessions.length === 0) return "No Codex sessions.";
  return sessions
    .map((session, index) => {
      const marker = index === 0 ? "•" : "-";
      const health = session.tmuxTarget ? ` | ${session.attachStatus ?? "unknown"}` : "";
      const strategy = session.submitStrategy ? `\n  submit: ${session.submitStrategy}` : "";
      return `${marker} ${session.id}\n  ${session.adapter} | ${session.status}${health}${session.paused ? " | paused" : ""}\n  ${session.label}${strategy}`;
    })
    .join("\n\n");
}

export function formatStatus(session: StoredSession, pendingCount: number, usage?: SessionTokenUsage): string {
  const lines = [
    "Active session",
    "",
    `name: ${session.label}`,
    `id: ${session.id}`,
    `adapter: ${session.adapter}${session.tmuxTarget ? " (tmux fallback)" : ""}`,
    `status: ${session.status}${session.paused ? " | paused" : ""}`,
    session.cwd ? `cwd: ${session.cwd}` : undefined,
    session.codexThreadId ? `thread: ${session.codexThreadId}` : undefined,
    session.activeTurnId ? `turn: ${session.activeTurnId}` : undefined,
    session.tmuxTarget ? `tmux: ${session.tmuxTarget}` : undefined,
    session.attachStatus ? `input: ${session.attachStatus}` : undefined,
    `pending: ${pendingCount}`,
    `updated: ${new Date(session.updatedAt).toISOString()}`,
    usage ? `usage: ${formatUsageLine(usage)}` : "usage: no usage reported yet"
  ];
  return lines.filter(Boolean).join("\n");
}

export function formatUsage(usage: SessionTokenUsage | undefined): string {
  if (!usage) return "No token usage has been reported for this session yet.";
  return [
    "Token usage",
    "",
    `total: ${number(usage.total.totalTokens)}`,
    `input: ${number(usage.total.inputTokens)} (${number(usage.total.cachedInputTokens)} cached)`,
    `output: ${number(usage.total.outputTokens)}`,
    `reasoning: ${number(usage.total.reasoningOutputTokens)}`,
    "",
    `last turn: ${number(usage.last.totalTokens)} total, ${number(usage.last.inputTokens)} input, ${number(usage.last.outputTokens)} output`,
    usage.modelContextWindow ? `context window: ${number(usage.modelContextWindow)}` : undefined,
    `updated: ${new Date(usage.updatedAt).toISOString()}`
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatLogs(lines: Array<{ timestamp: number; type: string; severity: string; text: string }>): string {
  if (lines.length === 0) return "No logs.";
  return truncateMiddle(lines
    .map((line) => {
      const ts = new Date(line.timestamp).toISOString().slice(11, 19);
      return `[${ts}] ${line.severity} ${line.type}\n${line.text}`;
    })
    .join("\n\n"), DEFAULT_MESSAGE_BUDGET);
}

export function escapeMd(value: string): string {
  return value.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

export function formatAgentMessage(session: StoredSession | undefined, text: string): string {
  const label = session?.label ?? "Codex";
  const cwd = session?.cwd ? `\n${session.cwd}` : "";
  return truncateMiddle(`[${label}]${cwd}\n\n${text.trim()}`, DEFAULT_MESSAGE_BUDGET);
}

export function appendAgentMessageChunk(existing: string, chunk: string, session?: StoredSession): string {
  if (session?.adapter === "appserver") return `${existing}${chunk}`;
  const trimmed = chunk.trim();
  if (!trimmed) return existing;
  return existing ? `${existing}\n${trimmed}` : trimmed;
}

export function truncateMiddle(value: string, maxChars = DEFAULT_MESSAGE_BUDGET): string {
  if (value.length <= maxChars) return value;
  if (maxChars < 80) return value.slice(0, maxChars);
  const marker = `\n\n[... ${value.length - maxChars} chars omitted ...]\n\n`;
  const available = maxChars - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
}

export function telegramTextLimit(): number {
  return TELEGRAM_TEXT_LIMIT;
}

function actionTitle(action: PendingAction): string {
  if (action.kind === "question") return "Codex question";
  if (action.kind === "mcpElicitation") return "MCP request";
  if (action.kind === "fileChangeApproval") return "File change approval";
  if (action.kind === "permissionsApproval") return "Permission approval";
  return "Command approval";
}

function actionBody(action: PendingAction): string {
  if (action.kind === "question") return action.body;
  const { method, params } = actionPayload(action.payload);
  const record = asRecord(params);
  if (action.kind === "mcpElicitation") {
    return [
      typeof record.serverName === "string" ? `server: ${record.serverName}` : undefined,
      typeof record.mode === "string" ? `mode: ${record.mode}` : undefined,
      typeof record.message === "string" ? record.message : action.body
    ]
      .filter(Boolean)
      .join("\n");
  }
  const command = typeof record.command === "string" ? record.command : undefined;
  const cwd = typeof record.cwd === "string" ? record.cwd : undefined;
  const reason = typeof record.reason === "string" ? record.reason : undefined;
  const changes = Array.isArray(record.changes) ? `changes: ${record.changes.length}` : undefined;
  return [
    method ? `method: ${method}` : undefined,
    reason,
    cwd ? `cwd: ${cwd}` : undefined,
    command ? `command:\n${command}` : undefined,
    changes,
    !command && !reason && !cwd && !changes ? action.body : undefined
  ]
    .filter(Boolean)
    .join("\n\n");
}

function actionPayload(payload: unknown): { method?: string; params?: unknown } {
  const record = asRecord(payload);
  const result: { method?: string; params?: unknown } = {};
  if (typeof record.method === "string") result.method = record.method;
  if ("params" in record) result.params = record.params;
  return result;
}

function formatUsageLine(usage: SessionTokenUsage): string {
  const context = usage.modelContextWindow ? ` / ${number(usage.modelContextWindow)}` : "";
  return `${number(usage.total.totalTokens)}${context} tokens; last ${number(usage.last.totalTokens)}`;
}

function number(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
