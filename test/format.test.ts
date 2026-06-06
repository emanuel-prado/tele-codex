import { describe, expect, it } from "vitest";
import { appendAgentMessageChunk, formatAgentMessage, truncateMiddle } from "../src/telegram/format.js";

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
    const session = {
      id: "s",
      adapter: "appserver" as const,
      label: "project",
      status: "active" as const,
      paused: false,
      createdAt: 1,
      updatedAt: 2
    };

    const text = ["The", " ", "hand", "off", " ", "says", "."].reduce(
      (buffer, chunk) => appendAgentMessageChunk(buffer, chunk, session),
      ""
    );

    expect(text).toBe("The handoff says.");
  });

  it("keeps PTY summary chunks separated by newlines", () => {
    const session = {
      id: "s",
      adapter: "pty" as const,
      label: "tmux",
      status: "active" as const,
      paused: false,
      createdAt: 1,
      updatedAt: 2
    };

    const text = ["first", "second"].reduce((buffer, chunk) => appendAgentMessageChunk(buffer, chunk, session), "");

    expect(text).toBe("first\nsecond");
  });
});
