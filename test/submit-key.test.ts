import { describe, expect, it } from "vitest";
import { parseSubmitSequence, ptySubmitSequence } from "../src/adapters/submit-key.js";

describe("submit key parsing", () => {
  it("maps ctrl-enter to CSI-u enhanced keyboard sequence", () => {
    expect(parseSubmitSequence("ctrl-enter")).toEqual([
      { type: "literal", value: "\x1b[13;5u" }
    ]);
  });

  it("supports comma-separated tmux fallbacks", () => {
    expect(parseSubmitSequence("escape,enter")).toEqual([
      { type: "tmuxKey", key: "Escape" },
      { type: "tmuxKey", key: "Enter" }
    ]);
  });

  it("supports managed PTY submit sequences", () => {
    expect(ptySubmitSequence("ctrl-enter")).toBe("\x1b[13;5u");
    expect(ptySubmitSequence("enter")).toBe("\r");
  });

  it("normalizes function-key submit strategies for tmux", () => {
    expect(parseSubmitSequence("f12")).toEqual([{ type: "tmuxKey", key: "F12" }]);
  });
});
