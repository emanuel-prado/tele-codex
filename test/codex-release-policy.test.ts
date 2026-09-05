import { describe, expect, it } from "vitest";
import { classifyRelease, selectNewestStableRelease } from "../scripts/codex-release.js";

describe("Codex release policy", () => {
  it("selects the newest stable version while ignoring prereleases", () => {
    expect(selectNewestStableRelease([
      "0.148.0",
      "0.149.0-alpha.1",
      "0.147.2",
      "0.149.0",
      "invalid"
    ])).toBe("0.149.0");
  });

  it("classifies a newer release with a passing contract check as compatible", () => {
    expect(classifyRelease("codex-cli 0.148.0", "0.149.0", true)).toBe("compatible");
  });

  it("classifies a newer release with a failing contract check as incompatible", () => {
    expect(classifyRelease("codex-cli 0.148.0", "0.149.0", false)).toBe("incompatible");
  });

  it("does not propose the checked release or an older release", () => {
    expect(classifyRelease("codex-cli 0.148.0", "0.148.0", true)).toBe("no-update");
    expect(classifyRelease("codex-cli 0.148.0", "0.147.1", false)).toBe("no-update");
  });
});
