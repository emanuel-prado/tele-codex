import type { Logger } from "pino";
import type { CodexAdapter } from "../types/adapter.js";
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
import type { AdapterKind, AttachSession, CodexEvent, LogEntry, SessionRef, StartSession, UserDecision } from "../types/events.js";
import { AsyncQueue } from "../utils/async-queue.js";
import { Store, type StoredSession } from "../store/store.js";
import { PtyAdapter, type ProbeResult, type TmuxPane } from "../adapters/pty-adapter.js";

export class SessionManager {
  private readonly adapters: Record<AdapterKind, CodexAdapter>;
  private readonly queue = new AsyncQueue<CodexEvent>();
  private activeSessionId?: string;

  constructor(
    adapters: Record<AdapterKind, CodexAdapter>,
    private readonly store: Store,
    private readonly defaultAdapter: AdapterKind,
    private readonly logger: Logger
  ) {
    this.adapters = adapters;
    for (const adapter of Object.values(adapters)) {
      void this.forwardEvents(adapter);
    }
  }

  async newSession(opts: StartSession = {}): Promise<SessionRef> {
    const adapterKind = opts.adapter ?? this.defaultAdapter;
    const session = await this.adapters[adapterKind].start(opts);
    this.setActiveId(session.id);
    return session;
  }

  async attach(opts: AttachSession): Promise<SessionRef> {
    const session = await this.adapters[opts.adapter].attach(opts);
    this.setActiveId(session.id);
    return session;
  }

  async listTmuxPanes(): Promise<TmuxPane[]> {
    return this.ptyAdapter().listTmuxPanes();
  }

  async probeTmuxSession(sessionId?: string, strategy?: string): Promise<ProbeResult> {
    const session = this.resolveSession(sessionId);
    if (session.adapter !== "pty") throw new Error("Active session is not a PTY/tmux session.");
    return this.ptyAdapter().probeSession(session.id, strategy);
  }

  async tryNextTmuxStrategy(sessionId?: string): Promise<ProbeResult> {
    const session = this.resolveSession(sessionId);
    if (session.adapter !== "pty") throw new Error("Active session is not a PTY/tmux session.");
    return this.ptyAdapter().tryNextStrategy(session.id);
  }

  markTmuxManualSubmit(sessionId?: string): void {
    const session = this.resolveSession(sessionId);
    if (session.adapter !== "pty") throw new Error("Active session is not a PTY/tmux session.");
    this.ptyAdapter().markManualSubmit(session.id);
  }

  markTmuxReady(sessionId?: string): void {
    const session = this.resolveSession(sessionId);
    if (session.adapter !== "pty") throw new Error("Active session is not a PTY/tmux session.");
    this.ptyAdapter().markReady(session.id);
  }

  listSessions(): StoredSession[] {
    return this.store.listSessions();
  }

  getActiveSession(): StoredSession | undefined {
    if (!this.activeSessionId) return undefined;
    return this.store.getSession(this.activeSessionId);
  }

  setActiveSession(sessionId: string): StoredSession {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    this.setActiveId(sessionId);
    return session;
  }

  async resumeSession(sessionId: string): Promise<StoredSession> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const adapter = this.adapters[session.adapter];
    if (adapter.resume) {
      await adapter.resume(session);
    } else if (session.status === "stopped") {
      throw new Error("Stopped session cannot be resumed.");
    }
    this.setActiveId(session.id);
    return this.store.getSession(session.id) ?? session;
  }

  async resumeThread(threadId: string, options: SessionControlOptions = {}): Promise<SessionRef> {
    const adapter = this.appServerAdapter();
    const session = await adapter.resumeThread(threadId, options);
    this.setActiveId(session.id);
    return session;
  }

  async resumeLatestThread(): Promise<SessionRef> {
    const [thread] = await this.listRemoteThreads(1);
    if (!thread) throw new Error("No previous Codex sessions found.");
    return this.resumeThread(thread.id);
  }

  async listRemoteThreads(limit = 10): Promise<CodexThreadSummary[]> {
    return this.appServerAdapter().listThreads(limit);
  }

  async searchRemoteThreads(term: string, limit = 10): Promise<CodexThreadSummary[]> {
    const adapter = this.appServerAdapter();
    if (!adapter.searchThreads) throw new Error("Configured app-server adapter does not support thread search.");
    return adapter.searchThreads(term, limit);
  }

  async rateLimits(): Promise<RateLimitSummary | undefined> {
    const adapter = this.appServerAdapter();
    if (!adapter.readRateLimits) throw new Error("Configured app-server adapter does not support account limits.");
    return adapter.readRateLimits();
  }

  progress(sessionId?: string): SessionProgress | undefined {
    return this.store.getProgress(this.resolveSession(sessionId).id);
  }

  diff(sessionId?: string): string | undefined {
    return this.store.getDiff(this.resolveSession(sessionId).id);
  }

  async goal(sessionId?: string): Promise<ThreadGoalSummary | undefined> {
    const session = this.resolveSession(sessionId);
    const adapter = this.requireAppServerSession(session);
    if (!adapter.getGoal) throw new Error("Configured app-server adapter does not support goals.");
    return adapter.getGoal(session.id);
  }

  async startGoal(objective: string, sessionId?: string): Promise<ThreadGoalSummary> {
    const session = this.resolveSession(sessionId);
    if (session.activeTurnId) throw new Error("Wait for or interrupt the active turn before starting a new goal.");
    const adapter = this.requireAppServerSession(session);
    if (!adapter.setGoal) throw new Error("Configured app-server adapter does not support goals.");
    const goal = await adapter.setGoal(session.id, objective, "active");
    await adapter.sendUserText(session.id, objective);
    return goal;
  }

  async setGoalStatus(status: "active" | "paused", sessionId?: string): Promise<ThreadGoalSummary> {
    const session = this.resolveSession(sessionId);
    const adapter = this.requireAppServerSession(session);
    if (!adapter.setGoal) throw new Error("Configured app-server adapter does not support goals.");
    return adapter.setGoal(session.id, undefined, status);
  }

  async clearGoal(sessionId?: string): Promise<boolean> {
    const session = this.resolveSession(sessionId);
    const adapter = this.requireAppServerSession(session);
    if (!adapter.clearGoal) throw new Error("Configured app-server adapter does not support goals.");
    return adapter.clearGoal(session.id);
  }

  async backgroundTerminals(sessionId?: string): Promise<BackgroundTerminalSummary[]> {
    const session = this.resolveSession(sessionId);
    const adapter = this.requireAppServerSession(session);
    if (!adapter.listBackgroundTerminals) throw new Error("Configured app-server adapter does not support background terminals.");
    return adapter.listBackgroundTerminals(session.id);
  }

  async terminateBackgroundTerminal(processId: string, sessionId?: string): Promise<boolean> {
    const session = this.resolveSession(sessionId);
    const adapter = this.requireAppServerSession(session);
    if (!adapter.terminateBackgroundTerminal) throw new Error("Configured app-server adapter does not support background terminals.");
    return adapter.terminateBackgroundTerminal(session.id, processId);
  }

  async listModels(limit = 20): Promise<CodexModelSummary[]> {
    return this.appServerAdapter().listModels(limit);
  }

  async setModel(model: string, sessionId?: string): Promise<void> {
    const session = this.resolveSession(sessionId);
    await this.requireAppServerSession(session).updateSettings(session.id, { model });
  }

  async setMode(mode: CollaborationModeKind, sessionId?: string): Promise<void> {
    const session = this.resolveSession(sessionId);
    await this.requireAppServerSession(session).setCollaborationMode(session.id, mode);
  }

  async compact(sessionId?: string): Promise<void> {
    const session = this.resolveSession(sessionId);
    await this.requireAppServerSession(session).compactThread(session.id);
  }

  async archive(sessionId?: string): Promise<void> {
    const session = this.resolveSession(sessionId);
    await this.requireAppServerSession(session).archiveThread(session.id);
  }

  async sendToActive(text: string): Promise<void> {
    const session = this.getActiveSession();
    if (!session) {
      throw new Error("No active Codex session. Use /new to start one or /sessions to resume an existing session.");
    }
    if (session.paused) throw new Error("Active session is paused.");
    await this.adapters[session.adapter].sendUserText(session.id, text);
  }

  async respondAction(decision: UserDecision): Promise<void> {
    const action = this.store.claimPendingAction(decision.actionId);
    if (!action) throw new Error("Action is no longer pending or has expired.");
    const session = this.store.getSession(action.sessionId);
    if (!session) {
      this.store.releasePendingAction(action.id);
      throw new Error("Session for pending action not found.");
    }
    try {
      await this.adapters[session.adapter].respondAction(decision);
      this.store.resolvePendingAction(action.id, "resolved");
      this.store.deleteInteractionDraft(action.id);
    } catch (error) {
      this.store.releasePendingAction(action.id);
      throw error;
    }
  }

  async expirePendingActions(): Promise<number> {
    let expired = 0;
    for (const candidate of this.store.listExpiredActions()) {
      const action = this.store.claimExpiredAction(candidate.id);
      if (!action) continue;
      const session = this.store.getSession(action.sessionId);
      if (!session) {
        this.store.resolvePendingAction(action.id, "orphaned");
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
        await this.adapters[session.adapter].respondAction(decision);
        this.store.resolvePendingAction(action.id, "expired");
        this.store.deleteInteractionDraft(action.id);
        expired += 1;
      } catch (error) {
        this.store.resolvePendingAction(action.id, "orphaned");
        this.logger.warn({ error, actionId: action.id }, "failed to expire pending action");
      }
    }
    return expired;
  }

  pause(sessionId?: string): void {
    const session = this.resolveSession(sessionId);
    this.store.setPaused(session.id, true);
  }

  resume(sessionId?: string): void {
    const session = this.resolveSession(sessionId);
    this.store.setPaused(session.id, false);
  }

  async interrupt(sessionId?: string): Promise<void> {
    const session = this.resolveSession(sessionId);
    await this.adapters[session.adapter].interrupt(session.id);
  }

  async kill(sessionId?: string): Promise<void> {
    const session = this.resolveSession(sessionId);
    await this.adapters[session.adapter].kill(session.id);
  }

  async logs(sessionId?: string, limit = 30): Promise<LogEntry[]> {
    const session = this.resolveSession(sessionId);
    return this.adapters[session.adapter].getRecentLog(session.id, limit);
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
    await Promise.all(Object.values(this.adapters).map((adapter) => adapter.close?.()));
  }

  private resolveSession(sessionId?: string): StoredSession {
    const session = sessionId ? this.store.getSession(sessionId) : this.getActiveSession();
    if (!session) throw new Error("No Codex session is active.");
    return session;
  }

  private setActiveId(sessionId: string): void {
    this.activeSessionId = sessionId;
    this.store.setRuntimeValue("last_active_session_id", sessionId);
  }

  private ptyAdapter(): PtyAdapter {
    const adapter = this.adapters.pty;
    if (!(adapter instanceof PtyAdapter)) {
      throw new Error("Configured PTY adapter does not support tmux operations.");
    }
    return adapter;
  }

  private appServerAdapter(): Required<Pick<CodexAdapter, "resumeThread" | "listThreads" | "listModels">> & CodexAdapter {
    const adapter = this.adapters.appserver;
    if (!adapter.resumeThread || !adapter.listThreads || !adapter.listModels) {
      throw new Error("Configured app-server adapter does not support Codex control commands.");
    }
    return adapter as Required<Pick<CodexAdapter, "resumeThread" | "listThreads" | "listModels">> & CodexAdapter;
  }

  private requireAppServerSession(
    session: StoredSession
  ): Required<Pick<CodexAdapter, "updateSettings" | "setCollaborationMode" | "compactThread" | "archiveThread">> & CodexAdapter {
    if (session.adapter !== "appserver") {
      throw new Error("This command requires an app-server session. Use /new or /resume to start an app-server session.");
    }
    const adapter = this.adapters.appserver;
    if (!adapter.updateSettings || !adapter.setCollaborationMode || !adapter.compactThread || !adapter.archiveThread) {
      throw new Error("Configured app-server adapter does not support Codex control commands.");
    }
    return adapter as Required<Pick<CodexAdapter, "updateSettings" | "setCollaborationMode" | "compactThread" | "archiveThread">> &
      CodexAdapter;
  }

  private async forwardEvents(adapter: CodexAdapter): Promise<void> {
    try {
      for await (const event of adapter.events()) {
        this.queue.push(event);
      }
    } catch (error) {
      this.logger.error({ error, adapter: adapter.kind }, "adapter event stream failed");
    }
  }
}
