import type { Logger } from "pino";
import { JsonRpcClient, type AppServerRpcClient, type JsonRpcMessage } from "./json-rpc-client.js";
import type { AppConfig } from "../config.js";
import type { AppServerRuntime } from "../types/adapter.js";
import type { AttachSession, CodexEvent, LogEntry, PendingAction, SessionRef, StartSession, UserDecision } from "../types/events.js";
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
import { AsyncQueue } from "../utils/async-queue.js";
import { createId, nowMs } from "../utils/ids.js";
import { Store } from "../store/store.js";
import type { StoredSession } from "../store/store.js";
import { noopRuntimeHealth, type RuntimeHealthReporter } from "../runtime/health.js";
import {
  buildMcpElicitationResponse,
  buildPermissionsResponse,
  buildRequestUserInputResponse,
  formatRequestUserInput,
  parseTokenUsage
} from "./app-server-protocol.js";
import { appServerFailure, AppServerFailure, normalizeAppServerFailure } from "./app-server-failure.js";

export class AppServerAdapter implements AppServerRuntime {
  private readonly rpc: AppServerRpcClient;
  private readonly queue = new AsyncQueue<CodexEvent>();
  private readonly sessionsByThread = new Map<string, { sessionId: string; generation: number }>();
  private readonly activeTurns = new Map<string, string>();
  private readonly sessionModels = new Map<string, string>();
  private readonly recoveringSessionIds = new Set<string>();
  private connected = false;
  private connectPromise: Promise<void> | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempt = 0;
  private stopping = false;
  private connectionGeneration: number | undefined;
  private connectingGeneration: number | undefined;
  private connectingFailure: AppServerFailure | undefined;
  private lastConnectionFailure: AppServerFailure | undefined;
  private runtimeSettled = false;
  private runtimeFailed = false;
  private resolveRuntime!: () => void;
  private rejectRuntime!: (error: Error) => void;
  private readonly runtimePromise = new Promise<void>((resolve, reject) => {
    this.resolveRuntime = resolve;
    this.rejectRuntime = reject;
  });

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly logger: Logger,
    private readonly health: RuntimeHealthReporter = noopRuntimeHealth,
    rpc?: AppServerRpcClient
  ) {
    void this.runtimePromise.catch(() => undefined);
    this.store.clearSessionAttachments();
    const startupOpenActions = this.store.listOpenActions();
    const orphaned = this.store.orphanOpenActions();
    if (orphaned > 0) {
      this.store.setRuntimeValue("startup_orphaned_actions", orphaned);
      this.store.setRuntimeValue("startup_orphaned_action_ids", startupOpenActions.map((action) => action.id));
      this.logger.warn({ orphaned }, "orphaned pending actions from a previous app-server connection");
    }
    this.rpc = rpc ?? new JsonRpcClient(logger, config.rpcTimeoutMs);
    this.rpc.on("activity", (generation: number) => {
      if (generation === this.connectionGeneration) this.health.appServer({ lastMessageAt: Date.now() });
    });
    this.rpc.on("message", (message: JsonRpcMessage, generation: number) => {
      void this.handleMessage(message, generation).catch((error) => this.failRuntime(error));
    });
    this.rpc.on("close", (_details: unknown, generation: number) => this.handleDisconnect(generation));
    this.rpc.on("failure", (failure: AppServerFailure, generation: number) => {
      if (generation === this.connectingGeneration) {
        this.connectingFailure = failure;
        this.rpc.close();
        return;
      }
      if (generation !== this.connectionGeneration) return;
      this.failRuntime(failure);
    });
  }

  async start(opts: StartSession): Promise<SessionRef> {
    await this.ensureConnected();
    const result = (await this.rpc.request("thread/start", {
      model: opts.model ?? null,
      cwd: opts.cwd ?? process.cwd(),
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      sessionStartSource: "startup",
      threadSource: "user"
    })) as { thread?: { id: string; cwd?: string; preview?: string } } | { id?: string };

    const threadId = extractThreadId(result);
    const model = stringField(result, "model");
    const generation = this.requireConnectionGeneration();
    const session: SessionRef = {
      id: createId("session"),
      adapter: "appserver",
      label: opts.label ?? `Codex ${threadId.slice(0, 8)}`,
      codexThreadId: threadId,
      connectionGeneration: generation
    };
    session.cwd = opts.cwd ?? process.cwd();
    if (model) this.sessionModels.set(session.id, model);
    const stored = this.store.upsertSession(session, "idle");
    this.sessionsByThread.set(threadId, { sessionId: stored.id, generation });
    if (opts.prompt) {
      await this.sendUserText(stored.id, opts.prompt);
    }
    return stored;
  }

  async attach(opts: AttachSession): Promise<SessionRef> {
    if (!opts.codexThreadId) throw new Error("App-server attach requires codexThreadId.");
    await this.ensureConnected();
    const result = await this.rpc.request("thread/resume", {
      threadId: opts.codexThreadId,
      model: opts.model ?? null,
      excludeTurns: true
    });
    const model = stringField(result, "model") ?? opts.model;
    const generation = this.requireConnectionGeneration();
    const existing = this.store.getSessionByCodexThreadId(opts.codexThreadId);
    const session: SessionRef = {
      id: existing?.id ?? createId("session"),
      adapter: "appserver",
      label: opts.label ?? labelForThread(asRecord((asRecord(result).thread)), opts.codexThreadId),
      codexThreadId: opts.codexThreadId,
      connectionGeneration: generation
    };
    if (opts.cwd) session.cwd = opts.cwd;
    if (model) this.sessionModels.set(session.id, model);
    const stored = this.store.upsertSession(session, "attached");
    this.sessionsByThread.set(opts.codexThreadId, { sessionId: stored.id, generation });
    return stored;
  }

  async resume(session: StoredSession): Promise<SessionRef> {
    if (!session.codexThreadId) throw new Error("Stored app-server session has no Codex thread id.");
    await this.ensureConnected();
    const result = await this.rpc.request("thread/resume", { threadId: session.codexThreadId, excludeTurns: true });
    const generation = this.requireConnectionGeneration();
    const model = stringField(result, "model");
    if (model) this.sessionModels.set(session.id, model);
    const stored = this.store.upsertSession({ ...session, connectionGeneration: generation }, "idle");
    this.sessionsByThread.set(session.codexThreadId, { sessionId: stored.id, generation });
    return stored;
  }

  async resumeThread(threadId: string, options: SessionControlOptions = {}): Promise<SessionRef> {
    await this.ensureConnected();
    const result = await this.rpc.request("thread/resume", {
      threadId,
      model: options.model ?? null,
      excludeTurns: true
    });
    const thread = asRecord(asRecord(result).thread);
    const model = stringField(result, "model") ?? options.model;
    const generation = this.requireConnectionGeneration();
    const existing = this.store.getSessionByCodexThreadId(threadId);
    const session: SessionRef = {
      id: existing?.id ?? createId("session"),
      adapter: "appserver",
      label: labelForThread(thread, threadId),
      codexThreadId: threadId,
      connectionGeneration: generation
    };
    const cwd = stringField(result, "cwd") ?? stringField(thread, "cwd");
    if (cwd) session.cwd = cwd;
    if (model) this.sessionModels.set(session.id, model);
    const stored = this.store.upsertSession(session, "idle");
    this.sessionsByThread.set(threadId, { sessionId: stored.id, generation });
    if (options.mode) await this.setCollaborationMode(stored.id, options.mode);
    return stored;
  }

  async sendUserText(sessionId: string, text: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const input = [{ type: "text", text, text_elements: [] }];
    const activeTurnId = this.activeTurns.get(sessionId);
    if (activeTurnId) {
      await this.rpc.request("turn/steer", {
        threadId: session.codexThreadId,
        expectedTurnId: activeTurnId,
        input
      });
      return;
    }
    const result = (await this.rpc.request("turn/start", {
      threadId: session.codexThreadId,
      input
    })) as { turn?: { id: string } };
    if (result.turn?.id) {
      this.store.setActiveTurn(sessionId, result.turn.id);
      this.activeTurns.set(sessionId, result.turn.id);
    }
  }

  async respondAction(decision: UserDecision): Promise<void> {
    const action = this.store.getPendingAction(decision.actionId);
    if (!action || action.requestId == null || action.connectionGeneration == null) {
      throw new Error("Pending app-server action not found.");
    }
    if (!this.connected || action.connectionGeneration !== this.connectionGeneration) {
      this.store.resolvePendingAction(action.id, "orphaned");
      throw new Error("This approval belongs to a disconnected app-server connection. Resume the thread and retry the original command.");
    }
    const generation = action.connectionGeneration;

    if (action.kind === "question") {
      this.rpc.respond(action.requestId, buildRequestUserInputResponse(action, decision.answers ?? decision.text ?? ""), generation);
    } else if (action.kind === "mcpElicitation") {
      this.rpc.respond(action.requestId, buildMcpElicitationResponse(decision.decision, decision.content), generation);
    } else if (action.kind === "permissionsApproval") {
      this.rpc.respond(action.requestId, buildPermissionsResponse(action, decision.decision, decision.permissionScope), generation);
    } else {
      const responseDecision = decision.protocolDecision ?? (decision.decision === "acceptForSession" ? "acceptForSession" : decision.decision);
      this.rpc.respond(action.requestId, { decision: responseDecision }, generation);
    }
  }

  async updateSettings(sessionId: string, options: SessionControlOptions): Promise<void> {
    const session = this.requireSession(sessionId);
    const params: Record<string, unknown> = { threadId: session.codexThreadId };
    if (options.model) params.model = options.model;
    if (options.mode) {
      const model = options.model ?? this.sessionModels.get(sessionId);
      params.collaborationMode = {
        mode: options.mode,
        settings: {
          model: model ?? "",
          reasoning_effort: null,
          developer_instructions: null
        }
      };
    }
    await this.rpc.request("thread/settings/update", params);
    if (options.model) this.sessionModels.set(sessionId, options.model);
  }

  async setCollaborationMode(sessionId: string, mode: CollaborationModeKind): Promise<void> {
    await this.updateSettings(sessionId, { mode });
  }

  async listModels(limit = 20): Promise<CodexModelSummary[]> {
    await this.ensureConnected();
    const result = asRecord(await this.rpc.request("model/list", { limit, includeHidden: false }));
    const data = Array.isArray(result.data) ? result.data : [];
    return data.map((item) => {
      const model = asRecord(item);
      const summary: CodexModelSummary = {
        id: String(model.id ?? model.model ?? ""),
        displayName: String(model.displayName ?? model.id ?? model.model ?? "")
      };
      if (typeof model.description === "string") summary.description = model.description;
      if (typeof model.hidden === "boolean") summary.hidden = model.hidden;
      return summary;
    }).filter((model) => model.id);
  }

  async listThreads(limit = 10): Promise<CodexThreadSummary[]> {
    await this.ensureConnected();
    const result = asRecord(
      await this.rpc.request("thread/list", {
        limit,
        sortKey: "updated_at",
        sortDirection: "desc",
        archived: false
      })
    );
    const data = Array.isArray(result.data) ? result.data : [];
    return data.map((item) => summarizeThread(asRecord(item))).filter((thread) => thread.id);
  }

  async searchThreads(term: string, limit = 10): Promise<CodexThreadSummary[]> {
    await this.ensureConnected();
    const result = asRecord(await this.rpc.request("thread/search", {
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
      searchTerm: term
    }));
    const data = Array.isArray(result.data) ? result.data : [];
    return data.map((item) => summarizeThread(asRecord(asRecord(item).thread))).filter((thread) => thread.id);
  }

  async readRateLimits(): Promise<RateLimitSummary | undefined> {
    await this.ensureConnected();
    const result = asRecord(await this.rpc.request("account/rateLimits/read"));
    const limits = parseRateLimits(asRecord(result.rateLimits));
    if (limits) this.store.setRateLimits(limits);
    return limits;
  }

  async getGoal(sessionId: string): Promise<ThreadGoalSummary | undefined> {
    const session = this.requireSession(sessionId);
    const result = asRecord(await this.rpc.request("thread/goal/get", { threadId: session.codexThreadId }));
    const goal = parseGoal(result.goal);
    this.store.setGoal(sessionId, goal);
    return goal;
  }

  async setGoal(sessionId: string, objective?: string, status?: ThreadGoalSummary["status"]): Promise<ThreadGoalSummary> {
    const session = this.requireSession(sessionId);
    const params: Record<string, unknown> = { threadId: session.codexThreadId };
    if (objective !== undefined) params.objective = objective;
    if (status !== undefined) params.status = status;
    const result = asRecord(await this.rpc.request("thread/goal/set", params));
    const goal = parseGoal(result.goal);
    if (!goal) throw new Error("Codex did not return the updated goal.");
    this.store.setGoal(sessionId, goal);
    return goal;
  }

  async clearGoal(sessionId: string): Promise<boolean> {
    const session = this.requireSession(sessionId);
    const result = asRecord(await this.rpc.request("thread/goal/clear", { threadId: session.codexThreadId }));
    this.store.setGoal(sessionId, undefined);
    return Boolean(result.cleared);
  }

  async listBackgroundTerminals(sessionId: string): Promise<BackgroundTerminalSummary[]> {
    const session = this.requireSession(sessionId);
    const result = asRecord(await this.rpc.request("thread/backgroundTerminals/list", { threadId: session.codexThreadId, limit: 20 }));
    const data = Array.isArray(result.data) ? result.data : [];
    return data.map(parseBackgroundTerminal).filter((item): item is BackgroundTerminalSummary => Boolean(item));
  }

  async terminateBackgroundTerminal(sessionId: string, processId: string): Promise<boolean> {
    const session = this.requireSession(sessionId);
    const result = asRecord(await this.rpc.request("thread/backgroundTerminals/terminate", {
      threadId: session.codexThreadId,
      processId
    }));
    return Boolean(result.terminated);
  }

  async compactThread(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.rpc.request("thread/compact/start", { threadId: session.codexThreadId });
  }

  async archiveThread(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.rpc.request("thread/archive", { threadId: session.codexThreadId });
    this.store.markThreadArchived(sessionId);
    this.sessionsByThread.delete(session.codexThreadId!);
    this.activeTurns.delete(sessionId);
  }

  async detach(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    this.store.markThreadDetached(sessionId);
    this.sessionsByThread.delete(session.codexThreadId!);
    this.activeTurns.delete(sessionId);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const generation = this.connectionGeneration;
    if (!this.connected || generation === undefined) {
      throw appServerFailure(
        "missing_connection",
        "App-server is disconnected. Wait for reconnection, then resume this Codex thread before interrupting.",
        { method: "turn/interrupt" }
      );
    }
    const attachment = this.sessionsByThread.get(session.codexThreadId);
    if (!attachment) {
      throw appServerFailure(
        "invalid_state",
        "This Codex thread has no current App-server Attachment. Resume it before interrupting.",
        { method: "turn/interrupt" }
      );
    }
    if (attachment.sessionId !== sessionId || attachment.generation !== generation || session.connectionGeneration !== generation) {
      throw appServerFailure(
        "generation_changed",
        "This Codex thread has a stale App-server Attachment. Resume it before interrupting.",
        { method: "turn/interrupt" }
      );
    }
    const turnId = this.activeTurns.get(sessionId);
    if (!turnId || session.activeTurnId !== turnId) {
      throw appServerFailure(
        "invalid_state",
        "No active Codex turn is attached. Wait for work to start or resume the thread.",
        { method: "turn/interrupt" }
      );
    }
    await this.rpc.request("turn/interrupt", { threadId: session.codexThreadId, turnId });
    const currentAttachment = this.sessionsByThread.get(session.codexThreadId);
    if (!this.connected || this.connectionGeneration !== generation ||
        currentAttachment?.sessionId !== sessionId || currentAttachment.generation !== generation) {
      throw appServerFailure(
        "generation_changed",
        "The App-server connection changed before interruption was confirmed. Resume the thread and check its current state.",
        { method: "turn/interrupt" }
      );
    }
    this.store.setActiveTurn(sessionId, null);
    this.activeTurns.delete(sessionId);
  }

  async getRecentLog(sessionId: string, limit: number): Promise<LogEntry[]> {
    return this.store.recentLogs(sessionId, limit);
  }

  events(): AsyncIterable<CodexEvent> {
    return this.queue;
  }

  async startTransport(): Promise<void> {
    this.stopping = false;
    this.health.appServer({
      state: "connecting",
      transport: this.config.appServerUrl ? "websocket" : "stdio",
      reconnectAttempt: 0,
      detail: "Establishing app-server transport."
    });
    try {
      await this.ensureConnected();
    } catch (error) {
      const failure = normalizeAppServerFailure(
        error,
        "transport_loss",
        "App-server connection failed during startup.",
        { method: "initialize" }
      );
      this.health.appServer({ state: "reconnecting", detail: failure.message });
      this.scheduleReconnect(failure);
    }
  }

  waitForFailure(): Promise<void> {
    return this.runtimePromise;
  }

  close(): void {
    if (this.stopping) return;
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.connected = false;
    this.rpc.close();
    this.queue.close();
    if (!this.runtimeFailed) {
      this.health.appServer({ state: "stopped", pid: undefined, detail: "App-server transport stopped." });
    }
    if (!this.runtimeSettled) {
      this.runtimeSettled = true;
      this.resolveRuntime();
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connect().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async connect(): Promise<void> {
    const generation = (this.store.getRuntimeValue<number>("appserver_connection_generation") ?? 0) + 1;
    this.store.setRuntimeValue("appserver_connection_generation", generation);
    this.connectingGeneration = generation;
    this.connectingFailure = undefined;
    try {
      if (this.config.appServerUrl) {
        await this.rpc.connectWebSocket(this.config.appServerUrl, process.env.TELE_CODEX_APP_SERVER_TOKEN, generation);
      } else {
        await this.rpc.connectStdio(this.config.codexCommand, generation);
      }
      try {
        await this.rpc.request("initialize", {
          clientInfo: { name: "tele-codex", title: "Telegram Companion for Codex", version: "0.1.0" },
          capabilities: { experimentalApi: true, requestAttestation: false }
        });
      } catch (error) {
        throw normalizeAppServerFailure(error, "remote_rejection", "App-server rejected initialization.", { method: "initialize" });
      }
      try {
        this.rpc.notify("initialized", undefined, generation);
      } catch (error) {
        throw normalizeAppServerFailure(error, "transport_loss", "App-server lost the initialized notification.", { method: "initialized" });
      }
      this.connectionGeneration = generation;
      this.connected = true;
      this.reconnectAttempt = 0;
      this.lastConnectionFailure = undefined;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      const transport = this.rpc.transportInfo();
      this.health.appServer({
        state: "connected",
        transport: transport.kind,
        pid: transport.pid,
        connectionGeneration: generation,
        reconnectAttempt: 0,
        detail: "App-server transport connected."
      });
    } catch (error) {
      this.connected = false;
      this.rpc.close();
      throw this.connectingFailure ?? normalizeAppServerFailure(error, "transport_loss", "App-server connection failed.", { method: "connect" });
    } finally {
      if (this.connectingGeneration === generation) this.connectingGeneration = undefined;
      this.connectingFailure = undefined;
    }
  }

  private handleDisconnect(generation: number): void {
    if (this.stopping) return;
    if (generation !== this.connectionGeneration) {
      this.logger.debug({ generation, currentGeneration: this.connectionGeneration }, "ignored stale app-server disconnect");
      return;
    }
    if (!this.connected && this.reconnectTimer) return;
    this.connected = false;
    this.connectionGeneration = undefined;
    this.health.appServer({ state: "reconnecting", pid: undefined, detail: "App-server transport disconnected." });
    this.activeTurns.clear();
    const openActions = this.store.listOpenActions(generation);
    const orphaned = this.store.orphanOpenActions(generation);
    const detachedSessionIds = new Set(this.store.clearSessionAttachments(generation));
    for (const [threadId, attachment] of this.sessionsByThread) {
      if (attachment.generation === generation) this.sessionsByThread.delete(threadId);
    }
    for (const action of openActions) {
      this.queue.push({
        type: "actionOrphaned",
        sessionId: action.sessionId,
        actionId: action.id,
        message: "App-server disconnected before Codex confirmed this request. Resume the thread and retry the original command."
      });
    }
    const sessions = this.store.listSessions().filter((item) => detachedSessionIds.has(item.id));
    for (const session of sessions) {
      this.recoveringSessionIds.add(session.id);
      this.queue.push({
        type: "error",
        sessionId: session.id,
        message: `App-server disconnected${orphaned ? `; ${orphaned} pending request(s) were orphaned` : ""}. Resume the thread, then retry the original command.`,
        willRetry: true
      });
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(error?: unknown): void {
    if (error !== undefined) {
      this.lastConnectionFailure = normalizeAppServerFailure(
        error,
        "transport_loss",
        "App-server reconnect failed.",
        { method: "connect" }
      );
    }
    if (this.reconnectTimer || this.stopping || this.runtimeSettled) return;
    if (this.reconnectAttempt >= this.config.appServerMaxReconnectAttempts) {
      const last = this.lastConnectionFailure;
      this.failRuntime(new AppServerFailure(
        last?.kind ?? "transport_loss",
        `App-server reconnect exhausted after ${this.reconnectAttempt} attempts.`,
        {
          method: last?.method ?? "connect",
          ...(last?.code !== undefined ? { code: last.code } : {}),
          ...(last && Object.prototype.hasOwnProperty.call(last, "data") ? { data: last.data } : {}),
          ...(last ? { cause: last } : {})
        }
      ));
      return;
    }
    const attempt = ++this.reconnectAttempt;
    const delay = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
    this.health.appServer({
      state: "reconnecting",
      reconnectAttempt: attempt,
      detail: `Reconnect attempt ${attempt}/${this.config.appServerMaxReconnectAttempts} in ${delay}ms.`
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.ensureConnected()
        .then(() => {
          for (const sessionId of this.recoveringSessionIds) {
            const session = this.store.getSession(sessionId);
            if (!session) continue;
            this.queue.push({
              type: "blocked",
              sessionId: session.id,
              reason: "App-server transport recovered. Use Resume in Telegram to reattach this thread."
            });
          }
          this.recoveringSessionIds.clear();
        })
        .catch((error) => {
          const failure = normalizeAppServerFailure(error, "transport_loss", "App-server reconnect failed.", { method: "connect" });
          this.logger.warn({ error: failure.message, delay, attempt }, "app-server reconnect failed");
          this.scheduleReconnect(failure);
        });
    }, delay);
  }

  private failRuntime(error: unknown): void {
    if (this.stopping || this.runtimeSettled) return;
    const failure = normalizeAppServerFailure(
      error,
      "protocol_defect",
      "App-server protocol handling failed."
    );
    this.runtimeFailed = true;
    this.runtimeSettled = true;
    this.health.appServer({ state: "failed", pid: undefined, detail: failure.message });
    this.rejectRuntime(failure);
  }

  private async handleMessage(message: JsonRpcMessage, generation: number): Promise<void> {
    if (generation !== this.connectionGeneration) {
      this.logger.debug({ generation, currentGeneration: this.connectionGeneration }, "ignored stale app-server message");
      return;
    }
    if (!message.method) return;
    if (message.id !== undefined) {
      await this.handleServerRequest(message, generation);
      return;
    }
    this.handleNotification(message, generation);
  }

  private async handleServerRequest(message: JsonRpcMessage, generation: number): Promise<void> {
    const params = asRecord(message.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const attachment = threadId ? this.sessionsByThread.get(threadId) : undefined;
    const sessionId = attachment?.generation === generation ? attachment.sessionId : undefined;
    if (!sessionId) {
      this.rpc.fail(message.id as string | number, -32001, "No Telegram session is attached to this Codex thread.", generation);
      return;
    }

    if (!isSupportedInteractiveRequest(message.method)) {
      this.rpc.fail(message.id as string | number, -32601, `Unsupported app-server request: ${message.method}`, generation);
      this.queue.push({
        type: "error",
        sessionId,
        message: `tele-codex safely rejected unsupported app-server request ${message.method}. Update the bridge before relying on this capability.`
      });
      return;
    }

    const action = makeActionFromServerRequest(
      sessionId,
      message.id as string | number,
      message.method ?? "unknown",
      params,
      this.config.approvalTimeoutMs,
      generation
    );
    this.store.putPendingAction(action);
    this.queue.push({
      type: action.kind === "question" ? "questionAsked" : "approvalRequested",
      sessionId,
      action
    });
  }

  private handleNotification(message: JsonRpcMessage, generation: number): void {
    const params = asRecord(message.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const attachment = threadId ? this.sessionsByThread.get(threadId) : undefined;
    const sessionId = attachment?.generation === generation ? attachment.sessionId : undefined;
    if (message.method === "serverRequest/resolved") {
      const requestId = params.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        const actionId = this.store.resolvePendingActionByRequestId(requestId, generation);
        const action = actionId ? this.store.getPendingAction(actionId) : undefined;
        if (actionId && action) this.queue.push({ type: "actionResolved", sessionId: action.sessionId, actionId });
      }
      return;
    }
    if (message.method === "account/rateLimits/updated") {
      const limits = parseRateLimits(asRecord(params.rateLimits));
      if (limits) {
        const previous = this.store.getRateLimits();
        this.store.setRateLimits(limits);
        const active = this.firstAttachedSession();
        if (active) {
          const event: Extract<CodexEvent, { type: "rateLimitsChanged" }> = { type: "rateLimitsChanged", sessionId: active.id, limits };
          if (previous && previous.usedPercent >= this.config.rateLimitWarnPercent && limits.usedPercent < this.config.rateLimitWarnPercent) {
            event.recovered = true;
          }
          this.queue.push(event);
        }
      }
      return;
    }
    if (message.method === "deprecationNotice" || message.method === "configWarning") {
      const active = this.firstAttachedSession();
      if (active) {
        const summary = String(params.summary ?? params.message ?? "Codex configuration warning");
        const details = typeof params.details === "string" ? `\n${params.details}` : "";
        this.queue.push({ type: "warning", sessionId: active.id, message: `${summary}${details}` });
      }
      return;
    }
    if (!sessionId) return;

    if (message.method === "turn/started") {
      const turn = asRecord(params.turn);
      if (typeof turn.id === "string") {
        this.store.setActiveTurn(sessionId, turn.id);
        this.activeTurns.set(sessionId, turn.id);
      }
      return;
    }

    if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      const event: CodexEvent = {
        type: "agentMessage",
        sessionId,
        text: params.delta
      };
      if (typeof params.turnId === "string") event.turnId = params.turnId;
      if (typeof params.itemId === "string") event.itemId = params.itemId;
      this.queue.push(event);
      return;
    }

    if (message.method === "turn/completed") {
      const turn = asRecord(params.turn);
      const status = turn.status === "failed" || turn.status === "interrupted" ? turn.status : "completed";
      this.store.setActiveTurn(sessionId, null, status === "failed" ? "error" : "idle");
      this.activeTurns.delete(sessionId);
      const event: CodexEvent = {
        type: "taskCompleted",
        sessionId,
        status,
        summary: `Turn ${status}.`
      };
      if (typeof turn.id === "string") event.turnId = turn.id;
      this.queue.push(event);
      return;
    }

    if (message.method === "thread/settings/updated") {
      const settings = asRecord(params.threadSettings);
      if (typeof settings.model === "string") this.sessionModels.set(sessionId, settings.model);
      const model = typeof settings.model === "string" ? `model ${settings.model}` : "settings updated";
      const mode = asRecord(settings.collaborationMode);
      const modeText = typeof mode.mode === "string" ? `, mode ${mode.mode}` : "";
      this.store.appendLog({ sessionId, type: "thread.settings", severity: "info", text: `${model}${modeText}` });
      return;
    }

    if (message.method === "thread/status/changed") {
      const statusRecord = asRecord(params.status);
      const status = typeof params.status === "string" ? params.status : String(statusRecord.type ?? "updated");
      this.store.appendLog({ sessionId, type: "thread.status", severity: "info", text: status });
      return;
    }

    if (message.method === "turn/plan/updated") {
      const plan: SessionProgress["plan"] = Array.isArray(params.plan)
        ? params.plan.flatMap((item) => {
            const record = asRecord(item);
            if (typeof record.step !== "string") return [];
            const rawStatus = String(record.status ?? "pending");
            const status = rawStatus === "in_progress" ? "inProgress" : rawStatus;
            if (status !== "pending" && status !== "inProgress" && status !== "completed") return [];
            return [{ step: record.step, status: status as SessionProgress["plan"][number]["status"] }];
          })
        : [];
      const progress: SessionProgress = {
        plan,
        updatedAt: Date.now()
      };
      if (typeof params.explanation === "string") progress.explanation = params.explanation;
      this.store.setProgress(sessionId, progress);
      return;
    }

    if (message.method === "turn/diff/updated" && typeof params.diff === "string") {
      this.store.setDiff(sessionId, params.diff);
      return;
    }

    if (message.method === "thread/goal/updated") {
      const goal = parseGoal(params.goal);
      if (goal) {
        this.store.setGoal(sessionId, goal);
        this.queue.push({ type: "goalChanged", sessionId, goal });
      }
      return;
    }

    if (message.method === "thread/goal/cleared") {
      this.store.setGoal(sessionId, undefined);
      return;
    }

    if (message.method === "warning" || message.method === "guardianWarning" || message.method === "model/rerouted") {
      const text = message.method === "model/rerouted"
        ? `Model rerouted from ${String(params.fromModel ?? "unknown")} to ${String(params.toModel ?? "unknown")}: ${String(params.reason ?? "no reason")}`
        : String(params.message ?? "Codex warning");
      this.queue.push({ type: "warning", sessionId, message: text });
      return;
    }

    if (message.method === "thread/tokenUsage/updated") {
      const usage = parseTokenUsage(params);
      if (usage) {
        this.store.setTokenUsage(sessionId, usage);
        this.store.appendLog({
          sessionId,
          type: "thread.usage",
          severity: "debug",
          text: `total ${usage.total.totalTokens}, last ${usage.last.totalTokens}`
        });
      }
      return;
    }

    if (message.method === "error") {
      const event: CodexEvent = {
        type: "error",
        sessionId,
        message: JSON.stringify(params.error ?? params),
        willRetry: Boolean(params.willRetry)
      };
      if (typeof params.turnId === "string") event.turnId = params.turnId;
      this.queue.push(event);
    }
  }

  private requireSession(sessionId: string) {
    const session = this.store.getSession(sessionId);
    if (!session?.codexThreadId) {
      throw appServerFailure("invalid_state", "The requested Codex thread is not available in local state.");
    }
    return session;
  }

  private requireConnectionGeneration(): number {
    if (!this.connected || this.connectionGeneration === undefined) {
      throw appServerFailure("missing_connection", "App-server is not connected.");
    }
    return this.connectionGeneration;
  }

  private firstAttachedSession(): StoredSession | undefined {
    for (const attachment of this.sessionsByThread.values()) {
      if (attachment.generation !== this.connectionGeneration) continue;
      const session = this.store.getSession(attachment.sessionId);
      if (session) return session;
    }
    return undefined;
  }
}

function extractThreadId(result: { thread?: { id: string } } | { id?: string }): string {
  if ("thread" in result && result.thread?.id) return result.thread.id;
  if ("id" in result && result.id) return result.id;
  throw appServerFailure("protocol_defect", "App-server returned a thread response without an id.", { method: "thread/start" });
}

function makeActionFromServerRequest(
  sessionId: string,
  requestId: string | number,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  connectionGeneration: number
): PendingAction {
  const command = typeof params.command === "string" ? params.command : undefined;
  const reason = typeof params.reason === "string" ? params.reason : undefined;
  const kind = method === "item/tool/requestUserInput"
    ? "question"
    : method === "item/fileChange/requestApproval" || method === "applyPatchApproval"
      ? "fileChangeApproval"
      : method === "item/permissions/requestApproval"
        ? "permissionsApproval"
        : method === "mcpServer/elicitation/request"
          ? "mcpElicitation"
          : "commandApproval";
  const title = kind === "question" ? "Codex asks" : "Codex approval required";
  const body =
    kind === "question"
      ? formatRequestUserInput({ params })
      : [reason, command ? `Command:\n${command}` : undefined, params.cwd ? `cwd: ${String(params.cwd)}` : undefined]
          .filter(Boolean)
          .join("\n\n");

  const action: PendingAction = {
    id: createId("action"),
    kind,
    sessionId,
    requestId,
    connectionGeneration,
    title,
    body: body || JSON.stringify(params),
    payload: { method, params },
    expiresAt: nowMs() + actionTimeout(params, timeoutMs)
  };
  if (typeof params.threadId === "string") action.threadId = params.threadId;
  if (typeof params.turnId === "string") action.turnId = params.turnId;
  if (typeof params.itemId === "string") action.itemId = params.itemId;
  return action;
}

function isSupportedInteractiveRequest(method: string | undefined): boolean {
  return method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/tool/requestUserInput" ||
    method === "mcpServer/elicitation/request" ||
    method === "item/permissions/requestApproval" ||
    method === "applyPatchApproval" ||
    method === "execCommandApproval";
}

function actionTimeout(params: Record<string, unknown>, configuredMs: number): number {
  const automatic = params.autoResolutionMs;
  return typeof automatic === "number" && automatic > 0 ? Math.min(configuredMs, automatic) : configuredMs;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringField(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  const field = record[key];
  return typeof field === "string" ? field : undefined;
}

function labelForThread(thread: Record<string, unknown>, fallbackId: string): string {
  const name = typeof thread.name === "string" && thread.name.trim() ? thread.name.trim() : undefined;
  const preview = typeof thread.preview === "string" && thread.preview.trim() ? thread.preview.trim() : undefined;
  return (name ?? preview ?? `Codex ${fallbackId.slice(0, 8)}`).slice(0, 80);
}

function summarizeThread(thread: Record<string, unknown>): CodexThreadSummary {
  const summary: CodexThreadSummary = { id: String(thread.id ?? "") };
  if (typeof thread.name === "string" && thread.name.trim()) summary.name = thread.name;
  if (typeof thread.preview === "string" && thread.preview.trim()) summary.preview = thread.preview;
  if (typeof thread.cwd === "string") summary.cwd = thread.cwd;
  if (typeof thread.modelProvider === "string") summary.modelProvider = thread.modelProvider;
  if (typeof thread.status === "string") summary.status = thread.status;
  else if (typeof asRecord(thread.status).type === "string") summary.status = String(asRecord(thread.status).type);
  if (typeof thread.updatedAt === "number") summary.updatedAt = thread.updatedAt;
  return summary;
}

function parseRateLimits(value: Record<string, unknown>, updatedAt = Date.now()): RateLimitSummary | undefined {
  const primary = asRecord(value.primary);
  if (typeof primary.usedPercent !== "number") return undefined;
  const limits: RateLimitSummary = { usedPercent: primary.usedPercent, updatedAt };
  if (typeof primary.resetsAt === "number") limits.resetsAt = primary.resetsAt;
  if (typeof primary.windowDurationMins === "number") limits.windowDurationMins = primary.windowDurationMins;
  if (typeof value.planType === "string") limits.planType = value.planType;
  return limits;
}

function parseGoal(value: unknown): ThreadGoalSummary | undefined {
  const goal = asRecord(value);
  if (typeof goal.objective !== "string" || typeof goal.status !== "string") return undefined;
  const allowed = new Set(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);
  if (!allowed.has(goal.status)) return undefined;
  const parsed: ThreadGoalSummary = {
    objective: goal.objective,
    status: goal.status as ThreadGoalSummary["status"],
    tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0,
    timeUsedSeconds: typeof goal.timeUsedSeconds === "number" ? goal.timeUsedSeconds : 0,
    updatedAt: typeof goal.updatedAt === "number" ? goal.updatedAt * 1000 : Date.now()
  };
  if (typeof goal.tokenBudget === "number") parsed.tokenBudget = goal.tokenBudget;
  return parsed;
}

function parseBackgroundTerminal(value: unknown): BackgroundTerminalSummary | undefined {
  const item = asRecord(value);
  if (typeof item.itemId !== "string" || typeof item.processId !== "string" || typeof item.command !== "string") return undefined;
  const parsed: BackgroundTerminalSummary = {
    itemId: item.itemId,
    processId: item.processId,
    command: item.command,
    cwd: typeof item.cwd === "string" ? item.cwd : ""
  };
  if (typeof item.osPid === "number") parsed.osPid = item.osPid;
  if (typeof item.cpuPercent === "number") parsed.cpuPercent = item.cpuPercent;
  if (typeof item.rssKb === "number") parsed.rssKb = item.rssKb;
  return parsed;
}
