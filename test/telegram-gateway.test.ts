import { Bot } from "grammy";
import { access, mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { LegacyTmuxBridge } from "../src/legacy/legacy-tmux-bridge.js";
import { RuntimeHealth } from "../src/runtime/health.js";
import { createLogger } from "../src/runtime/logger.js";
import type { SessionManager } from "../src/runtime/session-manager.js";
import { PolicyEngine } from "../src/security/policy.js";
import { Store } from "../src/store/store.js";
import type { StoredSession } from "../src/store/store.js";
import type { CodexEvent, PendingAction } from "../src/types/events.js";
import type { TelegramCommandDefinition, TelegramRuntime } from "../src/telegram/bot-runtime.js";
import { withPromptCallbackAck } from "../src/telegram/error-boundary.js";
import { TelegramGateway } from "../src/telegram/gateway.js";

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

class FakeTelegramRuntime implements TelegramRuntime {
  readonly calls: ApiCall[] = [];
  failDocumentDelivery = false;
  readonly messageFailures = new Map<number, { remaining: number; description: string }>();
  readonly sentMessageIds = new Map<number, number>();
  messageGate?: Promise<void>;
  readonly bot = new Bot("test-token", {
    botInfo: {
      id: 999,
      is_bot: true,
      first_name: "tele-codex",
      username: "tele_codex_test",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_manage_bots: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false
    }
  });

  constructor(callbackAckDelayMs?: number) {
    if (callbackAckDelayMs !== undefined) {
      this.bot.use((ctx, next) => withPromptCallbackAck(ctx, next, { debug() {} } as never, callbackAckDelayMs));
    }
    this.bot.api.config.use(async (_previous, method, payload) => {
      this.calls.push({ method, payload: payload as Record<string, unknown> });
      if (method === "sendDocument" && this.failDocumentDelivery) {
        return { ok: false, error_code: 500, description: "document delivery failed" } as never;
      }
      if (method === "sendMessage" || method === "editMessageText") {
        const chatId = Number((payload as { chat_id?: number }).chat_id ?? 100);
        if (method === "sendMessage") {
          await this.messageGate;
          const failure = this.messageFailures.get(chatId);
          if (failure && failure.remaining > 0) {
            failure.remaining -= 1;
            return { ok: false, error_code: 500, description: failure.description } as never;
          }
          this.sentMessageIds.set(chatId, this.calls.length + 100);
        }
        return {
          ok: true,
          result: {
            message_id: this.calls.length + 100,
            date: 1,
            chat: { id: chatId, type: "private" },
            text: String((payload as { text?: string }).text ?? "")
          }
        } as never;
      }
      return { ok: true, result: true } as never;
    });
  }

  async start(_commands: TelegramCommandDefinition[]): Promise<void> {}
  async wait(): Promise<void> {}
  stop(): void {}
}

describe("TelegramGateway dispatch", () => {
  let store: Store;
  let runtime: FakeTelegramRuntime;
  let gateway: TelegramGateway;
  let attachedThread: string | undefined;
  let activeSession: StoredSession | undefined;
  let killCount: number;
  let killError: Error | undefined;
  let forwardedText: string[];
  let launchedCwd: string | undefined;
  let activeDiff: string | undefined;
  let activeTranscript: string;
  let sessions: SessionManager;

  beforeEach(() => {
    store = new Store(":memory:");
    runtime = new FakeTelegramRuntime();
    activeSession = undefined;
    killCount = 0;
    killError = undefined;
    forwardedText = [];
    launchedCwd = undefined;
    activeDiff = undefined;
    activeTranscript = "";
    sessions = {
      getActiveSession: () => activeSession,
      attach: async ({ codexThreadId }: { codexThreadId: string }) => {
        attachedThread = codexThreadId;
        return { id: "session_1" };
      },
      kill: async () => {
        if (killError) throw killError;
        killCount += 1;
      },
      sendToSession: async (_sessionId: string, text: string) => { forwardedText.push(text); },
      newSession: async ({ cwd }: { cwd: string }) => {
        launchedCwd = cwd;
        return { id: "session_new" };
      },
      diff: () => activeDiff,
      transcript: () => activeTranscript,
      goal: async () => undefined
    } as unknown as SessionManager;
    const config = testConfig();
    gateway = new TelegramGateway(
      config,
      sessions,
      {} as LegacyTmuxBridge,
      store,
      new PolicyEngine(config),
      pino({ level: "silent" }),
      undefined,
      runtime
    );
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    store.close();
  });

  it.each([
    ["/help", "Plain text needs /send"],
    ["/retrydelivery", "Queued 0 failed notification(s) for retry."],
    ["/goal", "No goal is set for the active session."],
    ["/processes", "No active session."],
    ["/health", "tele-codex health: unavailable"]
  ])("dispatches %s without a network transport", async (command, expected) => {
    await runtime.bot.handleUpdate(messageUpdate(command, nextUpdateId()));
    expect(sentTexts(runtime)).toContainEqual(expect.stringContaining(expected));
  });

  it("applies configured transcript retention during an hourly maintenance tick", () => {
    vi.useFakeTimers();
    const writtenAt = new Date("2026-07-01T00:00:00Z");
    vi.setSystemTime(writtenAt);
    store.appendTranscript("session_1", "expired transcript");
    (gateway as unknown as { config: AppConfig }).config.transcriptRetentionDays = 5;

    const maintenanceAt = writtenAt.getTime() + 6 * 24 * 60 * 60 * 1000;
    (gateway as unknown as { performMaintenance(now: number): void }).performMaintenance(maintenanceAt);

    expect(store.getTranscript("session_1")).toBe("");
    expect((gateway as unknown as { nextMaintenanceAt: number }).nextMaintenanceAt)
      .toBe(maintenanceAt + 60 * 60 * 1000);
  });

  it("dispatches /attach through the injected runtime", async () => {
    await runtime.bot.handleUpdate(messageUpdate("/attach appserver thread_1", nextUpdateId()));
    expect(attachedThread).toBe("thread_1");
    expect(sentTexts(runtime)).toContain("Attached app-server thread:\nsession_1");
  });

  it("passes only the canonical contained workspace path to session launch", async () => {
    const parent = await mkdtemp(join(tmpdir(), "tele-codex-gateway-workspace-"));
    const project = join(parent, "project");
    const projectLink = join(parent, "project-link");
    await mkdir(project);
    await symlink(project, projectLink);

    await runtime.bot.handleUpdate(messageUpdate(`/new ${projectLink}`, nextUpdateId()));

    expect(launchedCwd).toBe(project);
    expect(sentTexts(runtime)).toContain("Started app-server session in project:\nsession_new");
  });

  it("deletes temporary diff exports after successful delivery", async () => {
    activeDiff = "private diff\n".repeat(500);

    await runtime.bot.handleUpdate(messageUpdate("/diff", nextUpdateId()));

    await expect(access(exportedDocumentPath(runtime))).rejects.toThrow();
  });

  it("deletes temporary transcript exports when delivery fails", async () => {
    activeSession = store.upsertSession({
      id: "session_1", adapter: "appserver", label: "one", codexThreadId: "thread_1"
    }, "idle");
    activeTranscript = "private transcript";
    runtime.failDocumentDelivery = true;

    await expect(runtime.bot.handleUpdate(messageUpdate("/transcript", nextUpdateId()))).rejects.toThrow(/document delivery failed/);

    await expect(access(exportedDocumentPath(runtime))).rejects.toThrow();
  });

  it("persists agent output only in the owning thread Transcript", async () => {
    activeSession = store.upsertSession({
      id: "session_1", adapter: "appserver", label: "one", codexThreadId: "thread_1"
    }, "active");

    await (gateway as unknown as { handleCodexEvent(event: CodexEvent): Promise<void> }).handleCodexEvent({
      type: "agentMessage",
      sessionId: activeSession.id,
      turnId: "turn_1",
      itemId: "item_1",
      text: "private attributed output"
    });

    expect(store.getTranscript(activeSession.id)).toContain("private attributed output");
    expect(store.recentLogs(activeSession.id, 10)).toEqual([]);
  });

  it("isolates a partial streamed-message fan-out failure and retains only the failed chat buffer", async () => {
    vi.useFakeTimers();
    const health = new RuntimeHealth();
    const streamingGateway = new TelegramGateway(
      testConfig(), sessions, {} as LegacyTmuxBridge, store, new PolicyEngine(testConfig()),
      pino({ level: "silent" }), health, runtime
    );
    activeSession = store.upsertSession({
      id: "session_1", adapter: "appserver", label: "one", codexThreadId: "thread_1"
    }, "active");
    vi.setSystemTime(1_000);
    store.rememberSessionChat(activeSession.id, 200);
    vi.setSystemTime(2_000);
    store.rememberSessionChat(activeSession.id, 100);
    runtime.messageFailures.set(100, { remaining: 1, description: "private /home/controller/token.txt" });

    await deliverAgentText(streamingGateway, activeSession.id, "fan-out text");
    await flushAgentText(streamingGateway, activeSession.id);

    expect(sentMessageChatIds(runtime)).toEqual([100, 200]);
    expect(bufferedChatIds(streamingGateway, activeSession.id)).toEqual([100]);
    expect(store.getMessageThread(200, sentMessageId(runtime, 200))).toBe(activeSession.id);
    expect(store.outboxCounts()).toEqual({ pending: 0, failed: 0 });
    expect(health.snapshot().delivery.lastFailure).not.toContain("/home/controller");
  });

  it("retries a failed streamed message, records recovery, and drops it at the retry limit", async () => {
    vi.useFakeTimers();
    let diagnostics = "";
    const logger = createLogger("warn", new Writable({
      write(chunk, _encoding, done) {
        diagnostics += chunk.toString();
        done();
      }
    }));
    const health = new RuntimeHealth();
    const streamingGateway = new TelegramGateway(
      testConfig(), sessions, {} as LegacyTmuxBridge, store, new PolicyEngine(testConfig()),
      logger, health, runtime
    );
    activeSession = store.upsertSession({
      id: "session_1", adapter: "appserver", label: "one", codexThreadId: "thread_1"
    }, "active");
    store.rememberSessionChat(activeSession.id, 100);
    runtime.messageFailures.set(100, { remaining: 2, description: "failed via https://api.telegram.org/bot123:secret/sendMessage" });

    await deliverAgentText(streamingGateway, activeSession.id, "recoverable text");
    await flushAgentText(streamingGateway, activeSession.id);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(bufferedChatIds(streamingGateway, activeSession.id)).toEqual([100]);

    await vi.advanceTimersByTimeAsync(2_400);
    expect(bufferedChatIds(streamingGateway, activeSession.id)).toEqual([]);
    expect(health.snapshot().delivery.lastSuccessAt).toBeDefined();
    expect(store.getMessageThread(100, sentMessageId(runtime, 100))).toBe(activeSession.id);

    await deliverAgentText(streamingGateway, activeSession.id, "terminal text");
    runtime.messageFailures.set(100, { remaining: 3, description: "terminal /private/path" });
    await flushAgentText(streamingGateway, activeSession.id);
    await vi.advanceTimersByTimeAsync(1_200);
    await vi.advanceTimersByTimeAsync(2_400);
    expect(bufferedChatIds(streamingGateway, activeSession.id)).toEqual([]);
    expect(diagnostics).toContain("retry limit");
    expect(diagnostics).not.toMatch(/123:secret|\/private\/path/);
  });

  it("coalesces concurrent flushes without duplicating sends or losing newly buffered text", async () => {
    vi.useFakeTimers();
    const streamingGateway = new TelegramGateway(
      testConfig(), sessions, {} as LegacyTmuxBridge, store, new PolicyEngine(testConfig()),
      pino({ level: "silent" }), undefined, runtime
    );
    activeSession = store.upsertSession({
      id: "session_1", adapter: "appserver", label: "one", codexThreadId: "thread_1"
    }, "active");
    store.rememberSessionChat(activeSession.id, 100);
    let releaseSend!: () => void;
    runtime.messageGate = new Promise<void>((resolve) => { releaseSend = resolve; });

    await deliverAgentText(streamingGateway, activeSession.id, "first");
    const firstFlush = flushAgentText(streamingGateway, activeSession.id);
    const concurrentFlush = flushAgentText(streamingGateway, activeSession.id);
    await deliverAgentText(streamingGateway, activeSession.id, " second");
    releaseSend();
    await Promise.all([firstFlush, concurrentFlush]);

    expect(sentTexts(runtime)).toHaveLength(1);
    expect(bufferedChatIds(streamingGateway, activeSession.id)).toEqual([100]);
    delete runtime.messageGate;
    await flushAgentText(streamingGateway, activeSession.id);
    expect(sentTexts(runtime)).toHaveLength(2);
    expect(sentTexts(runtime)[1]).toContain("second");
    expect(bufferedChatIds(streamingGateway, activeSession.id)).toEqual([]);
  });

  it("responds to unknown slash commands", async () => {
    await runtime.bot.handleUpdate(messageUpdate("/doesnotexist", nextUpdateId()));
    expect(sentTexts(runtime)).toContain("Unknown command. Run /help to see supported commands.");
  });

  it("dispatches owned panel callbacks and rejects unsupported control actions", async () => {
    await runtime.bot.handleUpdate(messageUpdate("/panel", nextUpdateId()));
    const statusControl = callbackData(runtime, "Status");
    runtime.calls.length = 0;
    await runtime.bot.handleUpdate(callbackUpdate(statusControl, nextUpdateId()));
    expect(sentTexts(runtime)).toContain("No active session.");
    expect(callbackAnswers(runtime).length).toBe(1);

    runtime.calls.length = 0;
    store.putCallbackToken({
      token: "unsupported", actionId: "main", resourceKind: "panel", chatId: 100, userId: 100,
      operation: "panel:removed", payload: {}, expiresAt: Date.now() + 60_000
    });
    await runtime.bot.handleUpdate(callbackUpdate("ctl:unsupported", nextUpdateId()));
    expect(callbackAnswers(runtime)).toContainEqual(expect.objectContaining({
      text: "This control is not valid for that operation.",
      show_alert: true
    }));
  });

  it("answers unknown callback payloads", async () => {
    await runtime.bot.handleUpdate(callbackUpdate("unknown-control", nextUpdateId()));
    expect(callbackAnswers(runtime)).toContainEqual(expect.objectContaining({
      text: "This control is unknown or no longer supported. Run the command again.",
      show_alert: true
    }));
  });

  it("rejects removed raw destructive callback payloads", async () => {
    await runtime.bot.handleUpdate(callbackUpdate("kill:missing", nextUpdateId()));
    expect(callbackAnswers(runtime)).toContainEqual(expect.objectContaining({
      text: "This control is unknown or no longer supported. Run the command again.",
      show_alert: true
    }));
  });

  it("does not expose raw approval commands", async () => {
    await runtime.bot.handleUpdate(messageUpdate("/approve action_1", nextUpdateId()));
    expect(sentTexts(runtime)).toContain("Unknown command. Run /help to see supported commands.");
  });

  it("uses the approval card as the only persistent waiting status", async () => {
    let submissions = 0;
    const approvalRuntime = new FakeTelegramRuntime();
    const approvalSessions = {
      ...sessions,
      respondAction: async () => { submissions += 1; }
    } as unknown as SessionManager;
    const approvalGateway = new TelegramGateway(
      testConfig(), approvalSessions, {} as LegacyTmuxBridge, store, new PolicyEngine(testConfig()),
      pino({ level: "silent" }), undefined, approvalRuntime
    );
    const action = approvalAction();
    store.upsertSession({
      id: action.sessionId, adapter: "appserver", label: "one", codexThreadId: "thread_1"
    }, "active");
    store.rememberSessionChat(action.sessionId, 100);
    store.putPendingAction(action);
    await deliverApproval(approvalGateway, action);
    const control = callbackData(approvalRuntime, "Approve");
    approvalRuntime.calls.length = 0;

    await approvalRuntime.bot.handleUpdate(callbackUpdate(control, nextUpdateId()));
    await approvalRuntime.bot.handleUpdate(callbackUpdate(control, nextUpdateId()));

    expect(submissions).toBe(1);
    expect(sentTexts(approvalRuntime)).toEqual([]);
    expect(editedTexts(approvalRuntime)).toContain("Decision submitted; waiting for Codex confirmation.");
    expect(callbackAnswers(approvalRuntime).at(-1)?.text).toMatch(/already used/i);
    const waitingEdit = approvalRuntime.calls.find((call) =>
      call.method === "editMessageText" && call.payload.text === "Decision submitted; waiting for Codex confirmation."
    );
    expect(waitingEdit?.payload.reply_markup).toEqual({ inline_keyboard: [] });

    await handleCodexEvent(approvalGateway, { type: "actionResolved", sessionId: action.sessionId, actionId: action.id });
    expect(editedTexts(approvalRuntime).at(-1)).toBe("Codex confirmed the response.");
    const confirmedEdit = approvalRuntime.calls.filter((call) => call.method === "editMessageText").at(-1);
    expect(confirmedEdit?.payload.message_id).toBe(waitingEdit?.payload.message_id);
  });

  it("does not create a second waiting message after automatic slow callback acknowledgement", async () => {
    vi.useFakeTimers();
    const slowRuntime = new FakeTelegramRuntime(100);
    const submission = deferred();
    const started = deferred();
    const slowSessions = {
      ...sessions,
      respondAction: async () => {
        started.resolve();
        await submission.promise;
      }
    } as unknown as SessionManager;
    const slowGateway = new TelegramGateway(
      testConfig(), slowSessions, {} as LegacyTmuxBridge, store, new PolicyEngine(testConfig()),
      pino({ level: "silent" }), undefined, slowRuntime
    );
    const action = approvalAction();
    store.upsertSession({
      id: action.sessionId, adapter: "appserver", label: "one", codexThreadId: "thread_1"
    }, "active");
    store.rememberSessionChat(action.sessionId, 100);
    store.putPendingAction(action);
    await deliverApproval(slowGateway, action);
    const control = callbackData(slowRuntime, "Approve");
    slowRuntime.calls.length = 0;

    const running = slowRuntime.bot.handleUpdate(callbackUpdate(control, nextUpdateId()));
    await started.promise;
    await vi.advanceTimersByTimeAsync(100);
    expect(callbackAnswers(slowRuntime)).toEqual([expect.objectContaining({ text: "Working..." })]);

    submission.resolve();
    await running;

    expect(sentTexts(slowRuntime)).toEqual([]);
    expect(editedTexts(slowRuntime)).toEqual(["Decision submitted; waiting for Codex confirmation."]);
  });

  it("rejects stale destructive controls and applies a valid confirmation once", async () => {
    activeSession = store.upsertSession({
      id: "session_1", adapter: "appserver", label: "one", codexThreadId: "thread_1"
    }, "active");
    await runtime.bot.handleUpdate(messageUpdate("/kill", nextUpdateId()));
    const staleControl = callbackData(runtime, "Confirm kill");
    store.setPaused(activeSession.id, true);
    activeSession = store.getSession(activeSession.id);
    runtime.calls.length = 0;

    await runtime.bot.handleUpdate(callbackUpdate(staleControl, nextUpdateId()));
    expect(killCount).toBe(0);
    expect(callbackAnswers(runtime)[0]?.text).toMatch(/session changed/i);

    runtime.calls.length = 0;
    await runtime.bot.handleUpdate(messageUpdate("/kill", nextUpdateId()));
    const validControl = callbackData(runtime, "Confirm kill");
    runtime.calls.length = 0;
    await runtime.bot.handleUpdate(callbackUpdate(validControl, nextUpdateId()));
    await runtime.bot.handleUpdate(callbackUpdate(validControl, nextUpdateId()));

    expect(killCount).toBe(1);
    expect(callbackAnswers(runtime).at(-1)?.text).toMatch(/already used/i);
  });

  it("consumes text for a non-pending interaction instead of forwarding it to Codex", async () => {
    activeSession = store.upsertSession({
      id: "session_1", adapter: "appserver", label: "one", codexThreadId: "thread_1"
    }, "active");
    const action: PendingAction = {
      id: "elicitation_1", kind: "mcpElicitation", sessionId: activeSession.id, requestId: 4,
      title: "MCP form", body: "form", expiresAt: Date.now() + 60_000,
      payload: { params: { requestedSchema: { type: "object", properties: { note: { type: "string" } } } } }
    };
    store.putPendingAction(action);
    store.putInteractionDraft({
      actionId: action.id, chatId: 100, userId: 100, questionIndex: 0, answers: {}, awaitingText: true
    });
    store.claimPendingAction(action.id);

    await runtime.bot.handleUpdate(messageUpdate("duplicate answer", nextUpdateId()));

    expect(forwardedText).toEqual([]);
    expect(sentTexts(runtime)).toContainEqual(expect.stringMatching(/already being submitted/i));
  });

  it("shows an actionable /kill failure instead of claiming the turn was interrupted", async () => {
    activeSession = store.upsertSession({
      id: "session_1", adapter: "appserver", label: "one", codexThreadId: "thread_1", connectionGeneration: 1
    }, "active");
    store.setActiveTurn(activeSession.id, "turn_1");
    activeSession = store.getSession(activeSession.id);
    killError = new Error("No active Codex turn is attached. Wait for work to start or resume the thread.");

    await runtime.bot.handleUpdate(messageUpdate("/kill", nextUpdateId()));
    const control = callbackData(runtime, "Confirm kill");
    runtime.calls.length = 0;
    await runtime.bot.handleUpdate(callbackUpdate(control, nextUpdateId()));

    expect(killCount).toBe(0);
    expect(callbackAnswers(runtime)).toContainEqual(expect.objectContaining({
      text: expect.stringMatching(/no active Codex turn.*resume/i),
      show_alert: true
    }));
    expect(sentTexts(runtime)).not.toContainEqual(expect.stringMatching(/Interrupted session/i));
  });
});

let updateId = 0;

function nextUpdateId(): number {
  updateId += 1;
  return updateId;
}

function messageUpdate(text: string, id: number): never {
  const command = text.split(" ")[0]!;
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1,
      chat: { id: 100, type: "private", first_name: "Controller" },
      from: { id: 100, is_bot: false, first_name: "Controller" },
      text,
      entities: [{ offset: 0, length: command.length, type: "bot_command" }]
    }
  } as never;
}

function callbackUpdate(data: string, id: number): never {
  return {
    update_id: id,
    callback_query: {
      id: `callback-${id}`,
      chat_instance: "test",
      from: { id: 100, is_bot: false, first_name: "Controller" },
      data,
      message: {
        message_id: id,
        date: 1,
        chat: { id: 100, type: "private", first_name: "Controller" },
        text: "control"
      }
    }
  } as never;
}

function sentTexts(runtime: FakeTelegramRuntime): string[] {
  return runtime.calls
    .filter((call) => call.method === "sendMessage")
    .map((call) => String(call.payload.text));
}

function editedTexts(runtime: FakeTelegramRuntime): string[] {
  return runtime.calls
    .filter((call) => call.method === "editMessageText")
    .map((call) => String(call.payload.text));
}

function sentMessageChatIds(runtime: FakeTelegramRuntime): number[] {
  return runtime.calls
    .filter((call) => call.method === "sendMessage")
    .map((call) => Number(call.payload.chat_id));
}

function sentMessageId(runtime: FakeTelegramRuntime, chatId: number): number {
  const messageId = runtime.sentMessageIds.get(chatId);
  if (!messageId) throw new Error(`Missing sent message for chat ${chatId}.`);
  return messageId;
}

async function deliverAgentText(gateway: TelegramGateway, sessionId: string, text: string): Promise<void> {
  await handleCodexEvent(gateway, {
    type: "agentMessage", sessionId, turnId: "turn_1", itemId: "item_1", text
  });
}

async function deliverApproval(gateway: TelegramGateway, action: PendingAction): Promise<void> {
  await handleCodexEvent(gateway, { type: "approvalRequested", sessionId: action.sessionId, action });
  await (gateway as unknown as { drainOutbox(): Promise<void> }).drainOutbox();
}

async function handleCodexEvent(gateway: TelegramGateway, event: CodexEvent): Promise<void> {
  await (gateway as unknown as { handleCodexEvent(event: CodexEvent): Promise<void> }).handleCodexEvent(event);
}

async function flushAgentText(gateway: TelegramGateway, sessionId: string): Promise<void> {
  await (gateway as unknown as { flushAgentMessage(id: string): Promise<void> }).flushAgentMessage(sessionId);
}

function bufferedChatIds(gateway: TelegramGateway, sessionId: string): number[] {
  const buffers = (gateway as unknown as {
    messageBuffers: Map<string, { deliveries?: Map<number, unknown> }>;
  }).messageBuffers;
  return [...(buffers.get(sessionId)?.deliveries?.keys() ?? [])].sort((left, right) => left - right);
}

function callbackAnswers(runtime: FakeTelegramRuntime): Record<string, unknown>[] {
  return runtime.calls
    .filter((call) => call.method === "answerCallbackQuery")
    .map((call) => call.payload);
}

function callbackData(runtime: FakeTelegramRuntime, label: string): string {
  for (const call of runtime.calls) {
    const markup = call.payload.reply_markup as { inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>> } | undefined;
    const button = markup?.inline_keyboard?.flat().find((item) => item.text === label);
    if (button?.callback_data) return button.callback_data;
  }
  throw new Error(`Missing callback button: ${label}`);
}

function exportedDocumentPath(runtime: FakeTelegramRuntime): string {
  const document = runtime.calls.find((call) => call.method === "sendDocument")?.payload.document as
    { fileData?: unknown } | undefined;
  if (typeof document?.fileData !== "string") throw new Error("Missing exported document path.");
  return document.fileData;
}

function testConfig(): AppConfig {
  return {
    botToken: "test-token",
    controllerUserId: 100,
    allowedChatIds: new Set(),
    dbPath: ":memory:",
    logLevel: "silent",
    approvalTimeoutMs: 900_000,
    rpcTimeoutMs: 30_000,
    appServerMaxReconnectAttempts: 3,
    rateLimitWarnPercent: 80,
    allowSessionGrants: false,
    codexCommand: "codex",
    tmuxSubmitKey: "enter",
    tmuxPasteSettleMs: 0,
    workspaceRoot: "/tmp"
  };
}

function approvalAction(): PendingAction {
  return {
    id: "approval_1",
    kind: "commandApproval",
    sessionId: "session_1",
    requestId: 1,
    connectionGeneration: 1,
    title: "Approval",
    body: "run true",
    payload: { method: "item/commandExecution/requestApproval", params: {} },
    expiresAt: Date.now() + 60_000
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
