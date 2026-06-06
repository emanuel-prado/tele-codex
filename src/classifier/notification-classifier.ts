import type { PendingAction } from "../types/events.js";
import { createId, createNonce, nowMs } from "../utils/ids.js";

export interface ClassifierConfig {
  approvalTimeoutMs: number;
}

export class NotificationClassifier {
  constructor(private readonly config: ClassifierConfig) {}

  classifyPtyOutput(sessionId: string, text: string): PendingAction | undefined {
    const normalized = stripAnsi(text);
    if (!normalized.trim()) return undefined;

    if (looksLikeApproval(normalized)) {
      return this.pendingAction(sessionId, "commandApproval", "Codex approval required", summarize(normalized));
    }

    if (looksLikeQuestion(normalized)) {
      return this.pendingAction(sessionId, "question", "Codex asked a question", summarize(normalized));
    }

    return undefined;
  }

  summarizeLog(text: string, maxChars = 3500): string {
    const stripped = stripAnsi(text).trim();
    if (stripped.length <= maxChars) return stripped;
    return `${stripped.slice(0, maxChars - 80)}\n\n[truncated: ${stripped.length - maxChars + 80} chars omitted]`;
  }

  private pendingAction(
    sessionId: string,
    kind: PendingAction["kind"],
    title: string,
    body: string
  ): PendingAction {
    return {
      id: createId("action"),
      kind,
      sessionId,
      title,
      body,
      payload: { source: "pty", body },
      nonce: createNonce(),
      expiresAt: nowMs() + this.config.approvalTimeoutMs
    };
  }
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function looksLikeApproval(text: string): boolean {
  return /approve\?|requires approval|do you want to allow|allow this command/i.test(text);
}

function looksLikeQuestion(text: string): boolean {
  return /\?\s*$/.test(text.trim()) || /which .* should i|choose|requires clarification/i.test(text);
}

function summarize(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-20).join("\n").slice(0, 3500);
}
