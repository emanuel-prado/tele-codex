import type { Logger } from "pino";
import { JsonRpcClient, type JsonRpcMessage } from "./json-rpc-client.js";
import type { AppConfig } from "../config.js";
import type { CodexAdapter } from "../types/adapter.js";
import type { AttachSession, CodexEvent, LogEntry, PendingAction, SessionRef, StartSession, UserDecision } from "../types/events.js";
import type { CodexModelSummary, CodexThreadSummary, CollaborationModeKind, SessionControlOptions } from "../types/control.js";
import { AsyncQueue } from "../utils/async-queue.js";
import { createId, createNonce, nowMs } from "../utils/ids.js";
import { Store } from "../store/store.js";
import type { StoredSession } from "../store/store.js";

export class AppServerAdapter implements CodexAdapter {
  readonly kind = "appserver" as const;
  private readonly rpc: JsonRpcClient;
  private readonly queue = new AsyncQueue<CodexEvent>();
  private readonly sessionsByThread = new Map<string, string>();
  private readonly activeTurns = new Map<string, string>();
  private readonly sessionModels = new Map<string, string>();
  private connected = false;

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly logger: Logger
  ) {
    this.rpc = new JsonRpcClient(logger);
    this.rpc.on("message", (message: JsonRpcMessage) => void this.handleMessage(message));
    this.rpc.on("stderr", (chunk: string) => {
      for (const session of this.store.listSessions().filter((item) => item.adapter === "appserver")) {
        this.store.appendLog({ sessionId: session.id, type: "appserver.stderr", severity: "debug", text: chunk });
      }
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
      const answers = decision.text ? { reply: { type: "text", text: decision.text } } : {};
      this.rpc.respond(action.requestId, { answers });
    } else {
      const responseDecision = decision.decision === "acceptForSession" ? "acceptForSession" : decision.decision;
      this.rpc.respond(action.requestId, { decision: responseDecision });
    }

    this.store.resolvePendingAction(action.id, "resolved");
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

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
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
      const status = typeof params.status === "string" ? params.status : "updated";
      this.store.appendLog({ sessionId, type: "thread.status", severity: "info", text: status });
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
  const kind = method.includes("requestUserInput")
    ? "question"
    : method.includes("fileChange")
      ? "fileChangeApproval"
      : method.includes("permissions")
        ? "permissionsApproval"
        : method.includes("elicitation")
          ? "mcpElicitation"
          : "commandApproval";
  const title = kind === "question" ? "Codex asks" : "Codex approval required";
  const body =
    kind === "question"
      ? formatQuestion(params)
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
    expiresAt: nowMs() + timeoutMs
  };
  if (typeof params.threadId === "string") action.threadId = params.threadId;
  if (typeof params.turnId === "string") action.turnId = params.turnId;
  if (typeof params.itemId === "string") action.itemId = params.itemId;
  return action;
}

function formatQuestion(params: Record<string, unknown>): string {
  const questions = Array.isArray(params.questions) ? params.questions : [];
  if (questions.length === 0) return JSON.stringify(params);
  return questions
    .map((question, index) => {
      const record = asRecord(question);
      const label = typeof record.question === "string" ? record.question : `Question ${index + 1}`;
      return `${index + 1}. ${label}`;
    })
    .join("\n");
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
  if (typeof thread.updatedAt === "number") summary.updatedAt = thread.updatedAt;
  return summary;
}
