import type { PendingAction } from "../types/events.js";
import type { StoredSession } from "../store/store.js";

const TELEGRAM_TEXT_LIMIT = 4096;
const DEFAULT_MESSAGE_BUDGET = 3900;

export function formatAction(action: PendingAction): string {
  return truncateMiddle(`*${escapeMd(action.title)}*\n\n${escapeMd(action.body)}`, DEFAULT_MESSAGE_BUDGET);
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
