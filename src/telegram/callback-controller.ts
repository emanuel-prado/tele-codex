import { Store, type CallbackToken } from "../store/store.js";
import { createNonce } from "../utils/ids.js";

const DEFAULT_TTL_MS = 10 * 60_000;

export interface CallbackScope {
  chatId: number;
  userId: number;
}

export interface CallbackTokenInput extends CallbackScope {
  actionId: string;
  operation: string;
  payload: unknown;
  expiresAt?: number;
}

export class CallbackControlError extends Error {}

/** Owns the one transaction boundary shared by restart-safe Telegram controls. */
export class TelegramCallbackController {
  constructor(private readonly store: Store) {}

  issue(input: CallbackTokenInput): string {
    const token = createNonce(12);
    this.store.putCallbackToken({
      token,
      actionId: input.actionId,
      chatId: input.chatId,
      userId: input.userId,
      operation: input.operation,
      payload: input.payload,
      expiresAt: input.expiresAt ?? Date.now() + DEFAULT_TTL_MS
    });
    return token;
  }

  async execute<T>(
    token: string,
    scope: CallbackScope,
    expectedOperation: string | readonly string[],
    action: (callback: CallbackToken) => Promise<T> | T
  ): Promise<T> {
    const claimId = createNonce(12);
    const callback = this.store.claimCallbackToken(token, scope.chatId, scope.userId, claimId);
    if (!callback) {
      throw new CallbackControlError("This control expired, was already used, or belongs to another chat or user.");
    }
    const expected = typeof expectedOperation === "string" ? [expectedOperation] : expectedOperation;
    if (!expected.includes(callback.operation)) {
      this.store.commitCallbackToken(token, claimId);
      throw new CallbackControlError("This control is not valid for that operation.");
    }
    try {
      const result = await action(callback);
      if (!this.store.commitCallbackToken(token, claimId)) {
        throw new Error("Callback claim was lost before it could be committed.");
      }
      return result;
    } catch (error) {
      this.store.releaseCallbackToken(token, claimId);
      throw error;
    }
  }
}
