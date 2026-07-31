import type { Logger } from "pino";
import type { AppServerRuntime } from "../types/adapter.js";
import type {
  BackgroundTerminalSummary,
  CodexModelSummary,
  CodexThreadSummary,
  CollaborationModeKind,
  RateLimitSummary,
  SessionControlOptions,
  SessionProgress,
  ThreadGoalSummary
} from "../types/control.js";
import type { AttachSession, CodexEvent, LogEntry, SessionRef, StartSession, UserDecision } from "../types/events.js";
import { AsyncQueue } from "../utils/async-queue.js";
import { Store, type StoredSession } from "../store/store.js";

export class SessionManager {
  private readonly queue = new AsyncQueue<CodexEvent>();
  private activeSessionId?: string;

  constructor(
    private readonly appserver: AppServerRuntime,
    private readonly store: Store,
    private readonly logger: Logger
  ) {
    void this.forwardEvents();
  }

  async newSession(opts: StartSession = {}): Promise<SessionRef> {
    const session = await this.appserver.start(opts);
    this.setActiveId(session.id);
    return session;
  }

  async attach(opts: AttachSession): Promise<SessionRef> {
    const session = await this.appserver.attach(opts);
    this.setActiveId(session.id);
    return session;
  }

  listSessions(includeAll = false): StoredSession[] {
    return this.store.listSessions(includeAll);
  }

  getActiveSession(): StoredSession | undefined {
    if (!this.activeSessionId) return undefined;
    const session = this.store.getSession(this.activeSessionId);
    if (!session || !this.canReceiveInput(session)) {
      this.clearActiveId(this.activeSessionId);
      return undefined;
    }
    return session;
  }

  setActiveSession(sessionId: string): StoredSession {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    if (!this.canReceiveInput(session)) throw new Error("This session cannot receive input. Resume it before selecting it.");
    this.setActiveId(sessionId);
    return session;
  }

  async resumeSession(sessionId: string): Promise<StoredSession> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    if (session.status === "archived") throw new Error("Archived threads cannot be resumed from local metadata. Use /resume to restore it from Codex history if available.");
    await this.appserver.resume(session);
    this.store.setPaused(session.id, false);
    this.setActiveId(session.id);
    return this.store.getSession(session.id) ?? session;
  }

  async resumeThread(threadId: string, options: SessionControlOptions = {}): Promise<SessionRef> {
    const session = await this.appserver.resumeThread(threadId, options);
    this.store.setPaused(session.id, false);
    this.setActiveId(session.id);
    return session;
  }

  async resumeLatestThread(): Promise<SessionRef> {
    const [thread] = await this.listRemoteThreads(1);
    if (!thread) throw new Error("No previous Codex sessions found.");
    return this.resumeThread(thread.id);
  }

  async listRemoteThreads(limit = 10): Promise<CodexThreadSummary[]> {
    return this.appserver.listThreads(limit);
  }

  async searchRemoteThreads(term: string, limit = 10): Promise<CodexThreadSummary[]> {
    return this.appserver.searchThreads(term, limit);
  }

  async rateLimits(): Promise<RateLimitSummary | undefined> {
    return this.appserver.readRateLimits();
  }

  progress(sessionId?: string): SessionProgress | undefined {
    return this.store.getProgress(this.resolveSession(sessionId).id);
  }

  diff(sessionId?: string): string | undefined {
    return this.store.getDiff(this.resolveSession(sessionId).id);
  }

  async goal(sessionId?: string): Promise<ThreadGoalSummary | undefined> {
    const session = this.resolveSession(sessionId);
    return this.appserver.getGoal(session.id);
  }

  async startGoal(objective: string, sessionId?: string): Promise<ThreadGoalSummary> {
    const session = this.resolveSession(sessionId);
    if (session.activeTurnId) throw new Error("Wait for or interrupt the active turn before starting a new goal.");
    const goal = await this.appserver.setGoal(session.id, objective, "active");
    await this.appserver.sendUserText(session.id, objective);
    return goal;
  }

  async setGoalStatus(status: "active" | "paused", sessionId?: string): Promise<ThreadGoalSummary> {
    const session = this.resolveSession(sessionId);
    return this.appserver.setGoal(session.id, undefined, status);
  }

  async clearGoal(sessionId?: string): Promise<boolean> {
    const session = this.resolveSession(sessionId);
    return this.appserver.clearGoal(session.id);
  }

  async backgroundTerminals(sessionId?: string): Promise<BackgroundTerminalSummary[]> {
    const session = this.resolveSession(sessionId);
    return this.appserver.listBackgroundTerminals(session.id);
  }

  async terminateBackgroundTerminal(processId: string, sessionId?: string): Promise<boolean> {
    const session = this.resolveSession(sessionId);
    return this.appserver.terminateBackgroundTerminal(session.id, processId);
  }

  async listModels(limit = 20): Promise<CodexModelSummary[]> {
    return this.appserver.listModels(limit);
  }

  async setModel(model: string, sessionId?: string): Promise<void> {
    const session = this.resolveSession(sessionId);
    await this.appserver.updateSettings(session.id, { model });
  }

  async setMode(mode: CollaborationModeKind, sessionId?: string): Promise<void> {
    const session = this.resolveSession(sessionId);
    await this.appserver.setCollaborationMode(session.id, mode);
  }

  async compact(sessionId?: string): Promise<void> {
    const session = this.resolveSession(sessionId);
    await this.appserver.compactThread(session.id);
  }

  async archive(sessionId?: string): Promise<void> {
    const session = this.resolveSession(sessionId);
    await this.appserver.archiveThread(session.id);
    this.store.markThreadArchived(session.id);
    this.clearActiveId(session.id);
  }

  async detach(sessionId?: string): Promise<void> {
    const session = this.resolveSession(sessionId);
    await this.appserver.detach(session.id);
    this.store.markThreadDetached(session.id);
    this.clearActiveId(session.id);
  }

  async forget(sessionId?: string): Promise<void> {
    const session = this.resolveSession(sessionId);
    if (session.codexThreadId) await this.appserver.detach(session.id);
    this.store.forgetThread(session.id);
    this.clearActiveId(session.id);
  }

  async sendToActive(text: string): Promise<void> {
    const session = this.getActiveSession();
    if (!session) {
      throw new Error("No active Codex session. Use /new to start one or /sessions to resume an existing session.");
    }
    await this.appserver.sendUserText(session.id, text);
  }

  async sendToSession(sessionId: string, text: string): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error("The selected Codex thread no longer exists.");
    if (!this.canReceiveInput(session)) {
      throw new Error("The selected Codex thread is detached or cannot receive input. Resume it and choose it again.");
    }
    await this.appserver.sendUserText(session.id, text);
  }

  async respondAction(decision: UserDecision): Promise<void> {
    const action = this.store.claimPendingAction(decision.actionId);
    if (!action) throw new Error("Action is no longer pending or has expired.");
    const session = this.store.getSession(action.sessionId);
    if (!session) {
      this.store.failPendingAction(action.id, "Session for pending action not found.");
      throw new Error("Session for pending action not found.");
    }
    try {
      await this.appserver.respondAction(decision);
    } catch (error) {
      if (this.store.getPendingAction(action.id)?.status === "submitting") {
        this.store.failPendingAction(action.id, error instanceof Error ? error.message : "Action submission failed.");
      }
      throw error;
    }
  }

  async expirePendingActions(): Promise<number> {
    let expired = 0;
    for (const action of this.store.listExpiredSubmissions()) {
      this.store.resolvePendingAction(action.id, "orphaned");
      this.store.deleteInteractionDraft(action.id);
      this.queue.push({
        type: "actionOrphaned",
        sessionId: action.sessionId,
        actionId: action.id,
        message: "Codex did not confirm this response before it expired. Resume the thread and retry the original command."
      });
      expired += 1;
    }
    for (const candidate of this.store.listExpiredActions()) {
      const action = this.store.claimExpiredAction(candidate.id);
      if (!action) continue;
      const session = this.store.getSession(action.sessionId);
      if (!session) {
        this.store.resolvePendingAction(action.id, "orphaned");
        this.queue.push({
          type: "actionOrphaned",
          sessionId: action.sessionId,
          actionId: action.id,
          message: "The session for this request is unavailable. Resume the thread and retry the original command."
        });
        continue;
      }
      const payload = action.payload && typeof action.payload === "object"
        ? (action.payload as { params?: { autoResolutionMs?: unknown } })
        : undefined;
      if (action.kind === "question" && typeof payload?.params?.autoResolutionMs === "number") {
        this.store.resolvePendingAction(action.id, "expired");
        this.store.deleteInteractionDraft(action.id);
        expired += 1;
        continue;
      }
      const decision: UserDecision = { actionId: action.id, decision: action.kind === "mcpElicitation" ? "cancel" : "decline" };
      if (action.kind === "question") decision.answers = {};
      try {
        await this.appserver.respondAction(decision);
        this.store.deleteInteractionDraft(action.id);
        expired += 1;
      } catch (error) {
        this.store.resolvePendingAction(action.id, "orphaned");
        this.store.deleteInteractionDraft(action.id);
        this.queue.push({
          type: "actionOrphaned",
          sessionId: action.sessionId,
          actionId: action.id,
          message: "This request expired before it could be submitted. Resume the thread and retry the original command."
        });
        this.logger.warn({ error, actionId: action.id }, "failed to expire pending action");
      }
    }
    return expired;
  }

  pause(sessionId?: string): void {
    const session = this.resolveSession(sessionId);
    this.store.setPaused(session.id, true);
    this.clearActiveId(session.id);
  }

  resume(sessionId?: string): void {
    const session = this.resolveSession(sessionId);
    this.store.setPaused(session.id, false);
    this.setActiveId(session.id);
  }

  async interrupt(sessionId?: string): Promise<void> {
    const session = this.resolveSession(sessionId);
    await this.appserver.interrupt(session.id);
  }

  async kill(sessionId?: string): Promise<void> {
    const session = this.resolveSession(sessionId);
    await this.appserver.interrupt(session.id);
  }

  async logs(sessionId?: string, limit = 30): Promise<LogEntry[]> {
    const session = this.resolveSession(sessionId);
    return this.appserver.getRecentLog(session.id, limit);
  }

  transcript(sessionId?: string): string {
    const session = this.resolveSession(sessionId);
    return this.store.getTranscript(session.id);
  }

  events(): AsyncIterable<CodexEvent> {
    return this.queue;
  }

  getLastActiveSessionId(): string | undefined {
    return this.store.getRuntimeValue<string>("last_active_session_id");
  }

  async close(): Promise<void> {
    await this.appserver.close();
  }

  private resolveSession(sessionId?: string): StoredSession {
    const session = sessionId ? this.store.getSession(sessionId) : this.getActiveSession();
    if (!session) throw new Error("No Codex session is active.");
    return session;
  }

  private setActiveId(sessionId: string): void {
    const session = this.store.getSession(sessionId);
    if (!session || !this.canReceiveInput(session)) {
      throw new Error("This session cannot receive input. Resume it before selecting it.");
    }
    this.activeSessionId = sessionId;
    this.store.setRuntimeValue("last_active_session_id", sessionId);
  }

  private clearActiveId(sessionId: string): void {
    if (this.activeSessionId === sessionId) delete this.activeSessionId;
    if (this.store.getRuntimeValue<string>("last_active_session_id") === sessionId) {
      this.store.deleteRuntimeValue("last_active_session_id");
    }
  }

  private canReceiveInput(session: StoredSession): boolean {
    if (session.paused) return false;
    return session.status === "attached" || session.status === "idle" || session.status === "active" || session.status === "blocked";
  }

  private async forwardEvents(): Promise<void> {
    try {
      for await (const event of this.appserver.events()) {
        this.queue.push(event);
      }
    } catch (error) {
      this.logger.error({ error }, "app-server event stream failed");
    }
  }
}
