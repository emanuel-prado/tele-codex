import type { SessionManager } from "../runtime/session-manager.js";
import { AppServerFailure } from "../adapters/app-server-failure.js";
import { resolveWorkspacePath } from "../runtime/workspace.js";
import type { ProposedPlan } from "../types/events.js";
import { Store } from "../store/store.js";
import { assertCallbackResource, TelegramCallbackController, type CallbackScope } from "./callback-controller.js";

const OPERATIONS = ["plan:implement", "plan:fresh", "plan:continue"] as const;

export class TelegramPlanController {
  constructor(
    private readonly workspaceRoot: string,
    private readonly store: Store,
    private readonly sessions: SessionManager,
    private readonly callbacks = new TelegramCallbackController(store)
  ) {}

  record(plan: ProposedPlan): void {
    this.store.proposedPlans.record(plan, () => {
      this.store.appendTranscript(plan.sessionId, plan.text, { turnId: plan.turnId, itemId: plan.itemId });
    });
  }

  publish(sessionId: string, turnId: string, chats: number[], userId: number, completedVersion?: number): boolean {
    return this.store.proposedPlans.publish(sessionId, turnId, (plan) => {
      const version = completedVersion ?? this.store.getSessionResourceVersion(sessionId);
      if (version === undefined) throw new Error("The plan's thread no longer exists.");
      const parts = splitPlan(plan.text);
      for (const chatId of chats) {
        parts.forEach((text, index) => this.store.enqueueOutbox(
          `plan:${sessionId}:${turnId}:${plan.itemId}:${index}`, chatId,
          { text: `Proposed plan (${index + 1}/${parts.length})\n\n${text}`, sessionId }
        ));
        const keyboard = OPERATIONS.map((operation, index) => [{
          text: ["Implement", "Clear and implement", "Keep planning"][index]!,
          callback_data: `plan:${this.callbacks.issue({
            actionId: sessionId, resourceKind: "proposed-plan", expectedVersion: version,
            chatId, userId, operation, payload: { turnId, itemId: plan.itemId },
            expiresAt: Date.now() + 10 * 60_000
          })}`
        }]);
        this.store.enqueueOutbox(`plan:${sessionId}:${turnId}:${plan.itemId}:choice`, chatId, {
          text: "Plan complete. Choose the next step.\nClear and implement starts a fresh thread with this plan; the original thread is preserved.\nControls expire in 10 minutes. After expiry, use /send to select the thread and continue explicitly.",
          keyboard, sessionId
        });
      }
    });
  }

  async choose(token: string, scope: CallbackScope): Promise<string> {
    return this.callbacks.execute(token, scope, OPERATIONS, async (callback) => {
      assertCallbackResource(callback, "proposed-plan", callback.actionId);
      const session = this.store.getSession(callback.actionId);
      const plan = this.store.proposedPlans.get(callback.actionId);
      const payload = callback.payload as { turnId?: string; itemId?: string };
      if (!session || !plan || plan.turnId !== payload.turnId || plan.itemId !== payload.itemId ||
          !plan.ready || plan.used || this.store.getSessionResourceVersion(session.id) !== callback.expectedVersion) {
        throw new Error("This plan control was used or the thread changed. Run /send to select the thread explicitly.");
      }
      if (session.status !== "idle" || session.paused || session.activeTurnId ||
          session.connectionGeneration !== plan.connectionGeneration) {
        throw new Error("This plan no longer has an idle live attachment. Resume the thread explicitly and use /send.");
      }
      let cwd: string | undefined;
      if (callback.operation === "plan:fresh") {
        if (!session.cwd) throw new Error("This thread has no workspace. Use /new to choose one explicitly.");
        cwd = (await resolveWorkspacePath(this.workspaceRoot, session.cwd)).path;
      }
      // Revalidate after filesystem I/O before the durable, cross-button claim.
      if (this.store.getSessionResourceVersion(session.id) !== callback.expectedVersion ||
          !this.store.proposedPlans.claim(session.id, plan.turnId, plan.itemId)) {
        throw new Error("This plan control was used or the thread changed. Run /send to continue explicitly.");
      }
      // An uncertain RPC outcome must never release this plan's claim. A callback
      // token retry alone cannot prove that an implementation turn did not start.
      let targetId = session.id;
      try {
        if (callback.operation === "plan:fresh") {
          const fresh = await this.sessions.newSession({ cwd: cwd!, ...(plan.model ? { model: plan.model } : {}) });
          targetId = fresh.id;
        }
        this.store.rememberSessionChat(targetId, scope.chatId);
        const targetVersion = this.store.getSessionResourceVersion(targetId);
        await this.sessions.setMode(callback.operation === "plan:continue" ? "plan" : "default", targetId);
        if (this.store.getSessionResourceVersion(targetId) !== targetVersion || this.store.getSession(targetId)?.status !== "idle") {
          throw new Error("Thread changed while selecting the next mode.");
        }
        if (callback.operation === "plan:continue") {
          this.store.clearInteractionDraftsForUser(scope.chatId, scope.userId);
          this.store.putRoutingCompose({ ...scope, sessionId: targetId,
            expectedVersion: this.store.getSessionResourceVersion(targetId)!, expiresAt: Date.now() + 5 * 60_000 });
          return "Plan mode enabled. Send your feedback as the next message within 5 minutes.";
        }
        await this.sessions.sendToSession(targetId, `Implement the following plan:\n\n${plan.text}`);
        return callback.operation === "plan:fresh"
          ? `Implementation started in a fresh thread: ${targetId}. The original thread is preserved.`
          : "Implementation started in the plan's original thread.";
      } catch (error) {
        const reason = error instanceof AppServerFailure ? ` (${error.kind.replaceAll("_", " ")})` : "";
        throw new Error(`The plan action could not be confirmed${reason}. It will not be replayed automatically. Check /status and /sessions; explicitly select thread ${targetId} with /send before retrying.`);
      }
    });
  }
}

function splitPlan(text: string): string[] {
  // Array.from avoids splitting UTF-16 surrogate pairs at Telegram boundaries.
  const characters = Array.from(text);
  const parts: string[] = [];
  let part = "";
  for (const character of characters) {
    if (part.length + character.length > 3600) { parts.push(part); part = ""; }
    part += character;
  }
  if (part) parts.push(part);
  return parts;
}
