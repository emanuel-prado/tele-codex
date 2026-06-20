import type { Logger } from "pino";
import { JsonRpcClient, type JsonRpcMessage } from "./json-rpc-client.js";
import type { AppConfig } from "../config.js";
import type { CodexAdapter } from "../types/adapter.js";
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
import { createId, createNonce, nowMs } from "../utils/ids.js";
import { Store } from "../store/store.js";
import type { StoredSession } from "../store/store.js";
import {
  buildMcpElicitationResponse,
  buildPermissionsResponse,
  buildRequestUserInputResponse,
  formatRequestUserInput,
  parseTokenUsage
} from "./app-server-protocol.js";

export class AppServerAdapter implements CodexAdapter {
  readonly kind = "appserver" as const;
  private readonly rpc: JsonRpcClient;
  private readonly queue = new AsyncQueue<CodexEvent>();
  private readonly sessionsByThread = new Map<string, string>();
  private readonly activeTurns = new Map<string, string>();
  private readonly sessionModels = new Map<string, string>();
  private connected = false;
  private connectPromise: Promise<void> | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempt = 0;
  private stopping = false;

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly logger: Logger
  ) {
    const orphaned = this.store.orphanOpenActions();
    if (orphaned > 0) {
      this.store.setRuntimeValue("startup_orphaned_actions", orphaned);
      this.logger.warn({ orphaned }, "orphaned pending actions from a previous app-server connection");
    }
    this.rpc = new JsonRpcClient(logger, config.rpcTimeoutMs);
    this.rpc.on("message", (message: JsonRpcMessage) => void this.handleMessage(message));
    this.rpc.on("stderr", (chunk: string) => {
      for (const session of this.store.listSessions().filter((item) => item.adapter === "appserver")) {
        this.store.appendLog({ sessionId: session.id, type: "appserver.stderr", severity: "debug", text: chunk });
      }
    });
    this.rpc.on("close", () => this.handleDisconnect());
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
    const session: SessionRef = {
      id: createId("session"),
      adapter: "appserver",
      label: opts.label ?? `Codex ${threadId.slice(0, 8)}`,
      codexThreadId: threadId
    };
    session.cwd = opts.cwd ?? process.cwd();
    this.sessionsByThread.set(threadId, session.id);
    if (model) this.sessionModels.set(session.id, model);
    this.store.upsertSession(session, "idle");
    this.queue.push({ type: "statusChanged", sessionId: session.id, status: "idle", detail: "App-server thread started." });

    if (opts.prompt) {
      await this.sendUserText(session.id, opts.prompt);
    }
    return session;
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
    const session: SessionRef = {
      id: createId("session"),
      adapter: "appserver",
      label: opts.label ?? labelForThread(asRecord((asRecord(result).thread)), opts.codexThreadId),
      codexThreadId: opts.codexThreadId
    };
    if (opts.cwd) session.cwd = opts.cwd;
    this.sessionsByThread.set(opts.codexThreadId, session.id);
    if (model) this.sessionModels.set(session.id, model);
    this.store.upsertSession(session, "attached");
    return session;
  }

  async resume(session: StoredSession): Promise<SessionRef> {
    if (!session.codexThreadId) throw new Error("Stored app-server session has no Codex thread id.");
    await this.ensureConnected();
    const result = await this.rpc.request("thread/resume", { threadId: session.codexThreadId, excludeTurns: true });
    this.sessionsByThread.set(session.codexThreadId, session.id);
    const model = stringField(result, "model");
    if (model) this.sessionModels.set(session.id, model);
    this.store.setSessionStatus(session.id, "idle");
    return session;
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
    const session: SessionRef = {
      id: createId("session"),
      adapter: "appserver",
      label: labelForThread(thread, threadId),
      codexThreadId: threadId
    };
    const cwd = stringField(result, "cwd") ?? stringField(thread, "cwd");
    if (cwd) session.cwd = cwd;
    this.sessionsByThread.set(threadId, session.id);
    if (model) this.sessionModels.set(session.id, model);
    this.store.upsertSession(session, "idle");
    if (options.mode) await this.setCollaborationMode(session.id, options.mode);
    return session;
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
      this.activeTurns.set(sessionId, result.turn.id);
      this.store.setActiveTurn(sessionId, result.turn.id);
    }
  }

  async respondAction(decision: UserDecision): Promise<void> {
    const action = this.store.getPendingAction(decision.actionId);
    if (!action?.requestId) throw new Error("Pending app-server action not found.");

    if (action.kind === "question") {
      this.rpc.respond(action.requestId, buildRequestUserInputResponse(action, decision.answers ?? decision.text ?? ""));
    } else if (action.kind === "mcpElicitation") {
      this.rpc.respond(action.requestId, buildMcpElicitationResponse(decision.decision, decision.content));
    } else if (action.kind === "permissionsApproval") {
      this.rpc.respond(action.requestId, buildPermissionsResponse(action, decision.decision, decision.permissionScope));
    } else {
      const responseDecision = decision.protocolDecision ?? (decision.decision === "acceptForSession" ? "acceptForSession" : decision.decision);
      this.rpc.respond(action.requestId, { decision: responseDecision });
    }

    if (decision.decision === "acceptForSession") {
      this.store.grantSession(action.id, action.sessionId, action.payload, Date.now() + 24 * 60 * 60 * 1000);
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
    this.store.setSessionStatus(sessionId, "stopped");
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const turnId = this.activeTurns.get(sessionId);
    if (!turnId) return;
    await this.rpc.request("turn/interrupt", { threadId: session.codexThreadId, turnId });
  }

  async kill(sessionId: string): Promise<void> {
    await this.interrupt(sessionId);
    this.store.setSessionStatus(sessionId, "stopped");
  }

  async getRecentLog(sessionId: string, limit: number): Promise<LogEntry[]> {
    return this.store.recentLogs(sessionId, limit);
  }

  events(): AsyncIterable<CodexEvent> {
    return this.queue;
  }

  close(): void {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.connected = false;
    this.rpc.close();
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
    if (this.config.appServerUrl) {
      await this.rpc.connectWebSocket(this.config.appServerUrl, process.env.TELE_CODEX_APP_SERVER_TOKEN);
    } else {
      await this.rpc.connectStdio(this.config.codexCommand);
    }
    await this.rpc.request("initialize", {
      clientInfo: { name: "tele-codex", title: "Telegram Companion for Codex", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    this.rpc.notify("initialized");
    this.connected = true;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private handleDisconnect(): void {
    if (this.stopping) return;
    if (!this.connected && this.reconnectTimer) return;
    this.connected = false;
    this.activeTurns.clear();
    const orphaned = this.store.orphanOpenActions();
    const sessions = this.store.listSessions().filter((item) => item.adapter === "appserver" && item.status !== "stopped");
    for (const session of sessions) {
      this.store.setSessionStatus(session.id, "error");
      this.queue.push({
        type: "error",
        sessionId: session.id,
        message: `App-server disconnected${orphaned ? `; ${orphaned} pending request(s) were orphaned` : ""}. Reconnection will restore controls, but resuming the thread requires your confirmation.`,
        willRetry: true
      });
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.ensureConnected()
        .then(() => {
          for (const session of this.store.listSessions().filter((item) => item.adapter === "appserver" && item.status !== "stopped")) {
            this.queue.push({
              type: "blocked",
              sessionId: session.id,
              reason: "App-server transport recovered. Use Resume in Telegram to reattach this thread."
            });
          }
        })
        .catch((error) => {
          this.logger.warn({ error, delay }, "app-server reconnect failed");
          this.scheduleReconnect();
        });
    }, delay);
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    if (!message.method) return;
    if (message.id !== undefined) {
      await this.handleServerRequest(message);
      return;
    }
    this.handleNotification(message);
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    const params = asRecord(message.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const sessionId = threadId ? this.sessionsByThread.get(threadId) : undefined;
    if (!sessionId) {
      this.rpc.fail(message.id as string | number, -32001, "No Telegram session is attached to this Codex thread.");
      return;
    }

    if (!isSupportedInteractiveRequest(message.method)) {
      this.rpc.fail(message.id as string | number, -32601, `Unsupported app-server request: ${message.method}`);
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
      this.config.approvalTimeoutMs
    );
    this.store.putPendingAction(action);
    this.queue.push({
      type: action.kind === "question" ? "questionAsked" : "approvalRequested",
      sessionId,
      action
    });
  }

  private handleNotification(message: JsonRpcMessage): void {
    const params = asRecord(message.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const sessionId = threadId ? this.sessionsByThread.get(threadId) : undefined;
    if (message.method === "account/rateLimits/updated") {
      const limits = parseRateLimits(asRecord(params.rateLimits));
      if (limits) {
        const previous = this.store.getRateLimits();
        this.store.setRateLimits(limits);
        const active = this.store.listSessions().find((item) => item.adapter === "appserver" && item.status !== "stopped");
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
      const active = this.store.listSessions().find((item) => item.adapter === "appserver" && item.status !== "stopped");
      if (active) {
        const summary = String(params.summary ?? params.message ?? "Codex configuration warning");
        const details = typeof params.details === "string" ? `\n${params.details}` : "";
        this.queue.push({ type: "warning", sessionId: active.id, message: `${summary}${details}` });
      }
      return;
    }
    if (!sessionId) return;

    this.store.appendLog({
      sessionId,
      type: message.method ?? "notification",
      severity: message.method === "error" ? "error" : "info",
      text: JSON.stringify(message.params)
    });

    if (message.method === "turn/started") {
      const turn = asRecord(params.turn);
      if (typeof turn.id === "string") {
        this.activeTurns.set(sessionId, turn.id);
        this.store.setActiveTurn(sessionId, turn.id);
      }
      this.queue.push({ type: "statusChanged", sessionId, status: "active" });
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
      this.activeTurns.delete(sessionId);
      this.store.setActiveTurn(sessionId, null);
      this.store.setSessionStatus(sessionId, status === "completed" ? "idle" : "error");
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
      this.queue.push({ type: "statusChanged", sessionId, status: "idle", detail: `${model}${modeText}` });
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

    if (message.method === "serverRequest/resolved") {
      const requestId = params.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        const actionId = this.store.resolvePendingActionByRequestId(requestId);
        if (actionId) this.queue.push({ type: "actionResolved", sessionId, actionId });
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
    if (!session?.codexThreadId) throw new Error(`Unknown app-server session: ${sessionId}`);
    return session;
  }
}

function extractThreadId(result: { thread?: { id: string } } | { id?: string }): string {
  if ("thread" in result && result.thread?.id) return result.thread.id;
  if ("id" in result && result.id) return result.id;
  throw new Error(`Unable to find thread id in app-server response: ${JSON.stringify(result)}`);
}

function makeActionFromServerRequest(
  sessionId: string,
  requestId: string | number,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number
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
    title,
    body: body || JSON.stringify(params),
    payload: { method, params },
    nonce: createNonce(),
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
