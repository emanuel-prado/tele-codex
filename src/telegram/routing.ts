import { SessionManager } from "../runtime/session-manager.js";
import { Store, type StoredSession } from "../store/store.js";
import type { CodexThreadSummary } from "../types/control.js";
import { createId, createNonce } from "../utils/ids.js";

const PICKER_TTL_MS = 10 * 60_000;
const COMPOSE_TTL_MS = 5 * 60_000;

interface SendPickerPayload {
  threadId: string;
  sessionId?: string;
  expectedVersion: number;
}

export interface RoutedText {
  session: StoredSession;
  source: "reply" | "compose" | "sticky" | "direct";
}

export class TelegramRouting {
  constructor(
    private readonly store: Store,
    private readonly sessions: SessionManager
  ) {}

  pickerToken(chatId: number, userId: number, thread: CodexThreadSummary, local?: StoredSession): string {
    const token = createNonce(12);
    const payload: SendPickerPayload = {
      threadId: thread.id,
      expectedVersion: local ? this.resourceVersion(local.id) : thread.updatedAt ?? 0
    };
    if (local) payload.sessionId = local.id;
    this.store.putCallbackToken({
      token,
      actionId: createId("send_picker"),
      chatId,
      userId,
      operation: "select-send-thread",
      payload,
      expiresAt: Date.now() + PICKER_TTL_MS
    });
    return token;
  }

  async selectPicker(token: string, chatId: number, userId: number): Promise<StoredSession> {
    const callback = this.store.consumeCallbackToken(token, chatId, userId);
    if (!callback || callback.operation !== "select-send-thread") {
      throw new Error("This thread picker expired, was already used, or belongs to another chat.");
    }
    const payload = callback.payload as Partial<SendPickerPayload>;
    if (typeof payload.threadId !== "string" || typeof payload.expectedVersion !== "number") {
      throw new Error("This thread picker is invalid. Run /send again.");
    }

    let session = payload.sessionId ? this.store.getSession(payload.sessionId) : this.store.getSessionByCodexThreadId(payload.threadId);
    if (session) {
      if (this.resourceVersion(session.id) !== payload.expectedVersion) {
        throw new Error("This thread changed after the picker opened. Run /send again.");
      }
      session = await this.ensureAttached(session);
    } else {
      const current = (await this.sessions.listRemoteThreads(25)).find((thread) => thread.id === payload.threadId);
      if (!current || (current.updatedAt ?? 0) !== payload.expectedVersion) {
        throw new Error("This thread is no longer available or changed after the picker opened.");
      }
      session = this.toStored(await this.sessions.resumeThread(payload.threadId));
    }

    this.store.putRoutingCompose({
      chatId,
      userId,
      sessionId: session.id,
      expectedVersion: this.resourceVersion(session.id),
      expiresAt: Date.now() + COMPOSE_TTL_MS
    });
    return session;
  }

  async sendDirect(chatId: number, userId: number, target: string, text: string): Promise<RoutedText> {
    const session = await this.resolveTarget(target);
    await this.send(chatId, session, text);
    return { session, source: "direct" };
  }

  async routeText(chatId: number, userId: number, text: string, replyToMessageId?: number): Promise<RoutedText | undefined> {
    if (replyToMessageId !== undefined) {
      const sessionId = this.store.getMessageThread(chatId, replyToMessageId);
      if (sessionId) {
        const session = await this.ensureAttached(this.requireSession(sessionId));
        await this.send(chatId, session, text);
        return { session, source: "reply" };
      }
    }

    const compose = this.store.consumeRoutingCompose(chatId, userId);
    if (compose) {
      let session = this.requireSession(compose.sessionId);
      if (this.resourceVersion(session.id) !== compose.expectedVersion) {
        throw new Error("The selected thread changed before this message was sent. Run /send again.");
      }
      session = await this.ensureAttached(session);
      await this.send(chatId, session, text);
      return { session, source: "compose" };
    }

    const stickySessionId = this.store.getStickyRoute(chatId, userId);
    if (stickySessionId) {
      const session = await this.ensureAttached(this.requireSession(stickySessionId));
      await this.send(chatId, session, text);
      return { session, source: "sticky" };
    }
    return undefined;
  }

  async setSticky(chatId: number, userId: number, target: string): Promise<StoredSession> {
    const session = await this.resolveTarget(target);
    this.store.setStickyRoute(chatId, userId, session.id);
    this.store.rememberSessionChat(session.id, chatId);
    return session;
  }

  clearSticky(chatId: number, userId: number): void {
    this.store.clearStickyRoute(chatId, userId);
  }

  private async resolveTarget(target: string): Promise<StoredSession> {
    const normalized = target.trim().toLowerCase();
    if (!normalized) throw new Error("Missing thread alias or id.");
    const local = this.store.listSessions(true).filter((session) =>
      [session.id, session.codexThreadId, session.label].some((value) => value?.toLowerCase() === normalized) ||
      session.id.toLowerCase().startsWith(normalized) ||
      session.codexThreadId?.toLowerCase().startsWith(normalized)
    );
    if (local.length > 1) throw new Error(`Thread target is ambiguous: ${target}`);
    if (local[0]) return this.ensureAttached(local[0]);

    const remote = (await this.sessions.listRemoteThreads(25)).filter((thread) =>
      [thread.id, thread.name].some((value) => value?.toLowerCase() === normalized) || thread.id.toLowerCase().startsWith(normalized)
    );
    if (remote.length === 0) throw new Error(`Unknown thread: ${target}`);
    if (remote.length > 1) throw new Error(`Thread target is ambiguous: ${target}`);
    return this.toStored(await this.sessions.resumeThread(remote[0]!.id));
  }

  private async ensureAttached(session: StoredSession): Promise<StoredSession> {
    if (session.status === "archived") throw new Error("Archived threads cannot receive messages.");
    if (session.status === "detached" || session.status === "error") return this.sessions.resumeSession(session.id);
    if (session.paused || session.status === "stopped") {
      throw new Error("The selected thread cannot receive input. Resume it before sending.");
    }
    return session;
  }

  private requireSession(sessionId: string): StoredSession {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error("The selected thread no longer exists. Run /send again.");
    return session;
  }

  private toStored(session: { id: string }): StoredSession {
    return this.requireSession(session.id);
  }

  private resourceVersion(sessionId: string): number {
    const version = this.store.getSessionResourceVersion(sessionId);
    if (version === undefined) throw new Error("The selected thread no longer exists. Run /send again.");
    return version;
  }

  private async send(chatId: number, session: StoredSession, text: string): Promise<void> {
    await this.sessions.sendToSession(session.id, text);
    this.store.rememberSessionChat(session.id, chatId);
  }
}
