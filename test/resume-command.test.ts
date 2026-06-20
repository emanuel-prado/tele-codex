import { describe, expect, it } from "vitest";
import { parseResumeCommand } from "../src/telegram/resume-command.js";

describe("resume command", () => {
  it("opens the picker when no argument is provided", () => {
    expect(parseResumeCommand("  ")).toEqual({ kind: "picker" });
  });

  it("recognizes the latest-session shortcut case-insensitively", () => {
    expect(parseResumeCommand(" LAST ")).toEqual({ kind: "last" });
  });

  it("preserves a direct session target", () => {
    expect(parseResumeCommand(" 019thread ")).toEqual({ kind: "target", target: "019thread" });
  });
});
