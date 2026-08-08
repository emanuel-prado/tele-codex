import { describe, expect, it } from "vitest";
import { parseSubmitSequence } from "../src/legacy/submit-key.js";

describe("parseSubmitSequence", () => {
  it("maps ctrl-enter to a literal CSI-u sequence", () => {
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

  it("normalizes function keys", () => {
    expect(parseSubmitSequence("f12")).toEqual([{ type: "tmuxKey", key: "F12" }]);
  });
});
