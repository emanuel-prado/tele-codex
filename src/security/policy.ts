import type { AppConfig } from "../config.js";

export class PolicyEngine {
  constructor(private readonly config: AppConfig) {}

  authorizeTelegramUser(userId: number | undefined, chatId: number | undefined): boolean {
    if (userId === undefined || chatId === undefined) return false;
    if (this.config.controllerUserId !== userId) return false;
    return this.config.allowedChatIds.size === 0
      ? chatId === this.config.controllerUserId
      : this.config.allowedChatIds.has(chatId);
  }
}
