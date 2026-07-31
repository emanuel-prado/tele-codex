import { describe, expect, it } from "vitest";
import { parseSubmitSequence } from "../src/adapters/submit-key.js";

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

  it("normalizes function-key submit strategies for tmux", () => {
    expect(parseSubmitSequence("f12")).toEqual([{ type: "tmuxKey", key: "F12" }]);
  });
});
