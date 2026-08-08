import { describe, expect, it } from "vitest";
import {
  appendAgentMessageChunk,
  formatAgentMessage,
  formatStatus,
  formatThreads,
  formatUsage,
  truncateMiddle
} from "../src/telegram/format.js";

describe("Telegram formatting", () => {
  it("keeps short messages unchanged", () => {
    expect(truncateMiddle("hello", 20)).toBe("hello");
  });

  it("middle-truncates oversized messages while preserving both ends", () => {
    const text = `${"a".repeat(80)}${"b".repeat(80)}${"c".repeat(80)}`;
    const truncated = truncateMiddle(text, 140);

    expect(truncated.length).toBeLessThanOrEqual(140);
    expect(truncated).toContain("[...");
    expect(truncated.startsWith("a")).toBe(true);
    expect(truncated.endsWith("c".repeat(10))).toBe(true);
    expect(truncated).not.toContain("b".repeat(40));
  });

  it("formats agent messages with session context", () => {
    const formatted = formatAgentMessage(
      {
        id: "s",
        adapter: "appserver",
        codexThreadId: "thread_1",
        label: "tele-codex",
        cwd: "/home/me/Workspace/tele-codex",
        status: "idle",
        paused: false,
        createdAt: 1,
        updatedAt: 2
      },
      "done"
    );

    expect(formatted).toContain("[tele-codex]");
    expect(formatted).toContain("/home/me/Workspace/tele-codex");
    expect(formatted).toContain("done");
  });

  it("preserves app-server delta spacing when buffering agent messages", () => {
    const text = ["The", " ", "hand", "off", " ", "says", "."].reduce(
      (buffer, chunk) => appendAgentMessageChunk(buffer, chunk),
      ""
    );

    expect(text).toBe("The handoff says.");
  });

  it("formats session status with pending count and usage", () => {
    const formatted = formatStatus(
      {
        id: "s",
        adapter: "appserver",
        label: "project",
        status: "active",
        paused: false,
        createdAt: 1,
        updatedAt: 2,
        cwd: "/workspace/project",
        codexThreadId: "thread_1"
      },
      2,
      {
        total: {
          totalTokens: 1000,
          inputTokens: 700,
          cachedInputTokens: 300,
          outputTokens: 300,
          reasoningOutputTokens: 20
        },
        last: {
          totalTokens: 100,
          inputTokens: 80,
          cachedInputTokens: 50,
          outputTokens: 20,
          reasoningOutputTokens: 5
        },
        modelContextWindow: 2000,
        updatedAt: 3
      }
    );

    expect(formatted).toContain("pending: 2");
    expect(formatted).toContain("usage: 1,000 / 2,000 tokens; last 100");
  });

  it("formats token usage details", () => {
    const formatted = formatUsage({
      total: {
        totalTokens: 1000,
        inputTokens: 700,
        cachedInputTokens: 300,
        outputTokens: 300,
        reasoningOutputTokens: 20
      },
      last: {
        totalTokens: 100,
        inputTokens: 80,
        cachedInputTokens: 50,
        outputTokens: 20,
        reasoningOutputTokens: 5
      },
      updatedAt: 3
    });

    expect(formatted).toContain("total: 1,000");
    expect(formatted).toContain("input: 700 (300 cached)");
    expect(formatted).toContain("last turn: 100 total");
  });

  it("formats resumable sessions with workspace and update context", () => {
    const formatted = formatThreads([
      {
        id: "thread_1",
        name: "Resume command",
        cwd: "/home/me/Workspace/tele-codex",
        updatedAt: 1_700_000_000
      }
    ]);

    expect(formatted).toContain("Previous Codex sessions");
    expect(formatted).toContain("Resume command");
    expect(formatted).toContain("/home/me/Workspace/tele-codex");
    expect(formatted).toContain("2023-11-14T22:13:20.000Z");
    expect(formatted).toContain("/resume last");
  });
});
