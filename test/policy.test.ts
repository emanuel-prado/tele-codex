import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../src/security/policy.js";
import type { AppConfig } from "../src/config.js";
import type { PendingAction } from "../src/types/events.js";

const baseConfig: AppConfig = {
  botToken: "token",
  controllerUserId: 100,
  allowedChatIds: new Set(),
  dbPath: "/tmp/test.db",
  logLevel: "silent",
  approvalTimeoutMs: 1000,
  rpcTimeoutMs: 30000,
  appServerMaxReconnectAttempts: 3,
  rateLimitWarnPercent: 80,
  allowSessionGrants: false,
  codexCommand: "codex",
  tmuxSubmitKey: "C-j",
  tmuxPasteSettleMs: 250,
  workspaceRoot: "/tmp"
};

describe("PolicyEngine", () => {
  it("rejects unknown Telegram users", () => {
    const policy = new PolicyEngine(baseConfig);
    expect(policy.authorizeTelegramUser(100, 100)).toBe(true);
    expect(policy.authorizeTelegramUser(101, 101)).toBe(false);
  });

  it("limits an empty chat allow-list to the Controller's private chat", () => {
    const policy = new PolicyEngine(baseConfig);
    expect(policy.authorizeTelegramUser(100, 100)).toBe(true);
    expect(policy.authorizeTelegramUser(100, -100123)).toBe(false);
  });

  it("allows the Controller in explicitly configured chats", () => {
    const policy = new PolicyEngine({ ...baseConfig, allowedChatIds: new Set([-100123]) });
    expect(policy.authorizeTelegramUser(100, -100123)).toBe(true);
    expect(policy.authorizeTelegramUser(100, 100)).toBe(false);
  });

  it("rejects session grants when disabled", () => {
    const policy = new PolicyEngine(baseConfig);
    const action: PendingAction = {
      id: "a",
      kind: "commandApproval",
      sessionId: "s",
      title: "title",
      body: "body",
      payload: {},
      nonce: "n",
      expiresAt: Date.now() + 1000
    };

    expect(() =>
      policy.validateDecision(action, { actionId: "a", decision: "acceptForSession" }, "n")
    ).toThrow(/disabled/);
  });
});
