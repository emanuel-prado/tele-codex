import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("parses allow-lists and defaults", () => {
    const config = loadConfig({
      TELE_CODEX_BOT_TOKEN: "token",
      TELE_CODEX_ALLOWED_USER_IDS: "1,2",
      TELE_CODEX_DB_PATH: "/tmp/tele-codex-test.db"
    });

    expect(config.allowedUserIds.has(1)).toBe(true);
    expect(config.allowedUserIds.has(2)).toBe(true);
    expect(config.allowSessionGrants).toBe(true);
    expect(config.rpcTimeoutMs).toBe(30_000);
    expect(config.rateLimitWarnPercent).toBe(80);
    expect(config.tmuxSubmitKey).toBe("enter");
    expect(config.tmuxPasteSettleMs).toBe(250);
    expect(config.workspaceRoot.endsWith("/Workspace")).toBe(true);
  });
});
