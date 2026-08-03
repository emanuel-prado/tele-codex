import { Bot } from "grammy";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { LegacyTmuxBridge } from "../src/legacy/legacy-tmux-bridge.js";
import type { SessionManager } from "../src/runtime/session-manager.js";
import { PolicyEngine } from "../src/security/policy.js";
import { Store } from "../src/store/store.js";
import type { StoredSession } from "../src/store/store.js";
import type { PendingAction } from "../src/types/events.js";
import type { TelegramCommandDefinition, TelegramRuntime } from "../src/telegram/bot-runtime.js";
import { TelegramGateway } from "../src/telegram/gateway.js";

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

class FakeTelegramRuntime implements TelegramRuntime {
  readonly calls: ApiCall[] = [];
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

  constructor() {
    this.bot.api.config.use(async (_previous, method, payload) => {
      this.calls.push({ method, payload: payload as Record<string, unknown> });
      if (method === "sendMessage" || method === "editMessageText") {
        return {
          ok: true,
          result: {
            message_id: this.calls.length + 100,
            date: 1,
            chat: { id: Number((payload as { chat_id?: number }).chat_id ?? 100), type: "private" },
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
  let forwardedText: string[];

  beforeEach(() => {
    store = new Store(":memory:");
    runtime = new FakeTelegramRuntime();
    activeSession = undefined;
    killCount = 0;
    forwardedText = [];
    const sessions = {
      getActiveSession: () => activeSession,
      attach: async ({ codexThreadId }: { codexThreadId: string }) => {
        attachedThread = codexThreadId;
        return { id: "session_1" };
      },
      kill: async () => { killCount += 1; },
      sendToSession: async (_sessionId: string, text: string) => { forwardedText.push(text); },
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

  afterEach(() => store.close());

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

  it("dispatches /attach through the injected runtime", async () => {
    await runtime.bot.handleUpdate(messageUpdate("/attach appserver thread_1", nextUpdateId()));
    expect(attachedThread).toBe("thread_1");
    expect(sentTexts(runtime)).toContain("Attached app-server thread:\nsession_1");
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
