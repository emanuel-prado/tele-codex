import type { AppConfig } from "../config.js";
import type { PendingAction, UserDecision } from "../types/events.js";

export class PolicyEngine {
  constructor(private readonly config: AppConfig) {}

  authorizeTelegramUser(userId: number | undefined, chatId: number | undefined): boolean {
    if (userId === undefined || chatId === undefined) return false;
    if (!this.config.allowedUserIds.has(userId)) return false;
    return this.config.allowedChatIds.size === 0 || this.config.allowedChatIds.has(chatId);
  }

  validateDecision(action: PendingAction, decision: UserDecision, nonce: string): void {
    if (action.nonce !== nonce) {
      throw new Error("Rejected callback with invalid nonce.");
    }
    if (Date.now() > action.expiresAt) {
      throw new Error("Approval request expired.");
    }
    if (decision.decision === "acceptForSession" && !this.config.allowSessionGrants) {
      throw new Error("Session-level approval grants are disabled.");
    }
  }
}
