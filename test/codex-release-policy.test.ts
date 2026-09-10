import { readFile } from "node:fs/promises";
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

  it("authenticates the compatible checkout with the publishing token", async () => {
    const workflow = await readFile(new URL("../.github/workflows/codex-release-check.yml", import.meta.url), "utf8");
    const compatibleJob = workflow.split("\n  compatible:\n", 2)[1]?.split("\n  incompatible:\n", 1)[0] ?? "";

    expect(compatibleJob).toContain([
      "      - name: Checkout develop",
      "        uses: actions/checkout@v4",
      "        with:",
      "          ref: develop",
      "          token: ${{ secrets.RELEASE_PLEASE_TOKEN }}"
    ].join("\n"));
  });
});
