import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { inspectConfig, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("parses allow-lists and defaults", () => {
    const config = loadConfig({
      TELE_CODEX_BOT_TOKEN: "token",
      TELE_CODEX_ALLOWED_USER_IDS: "1",
      TELE_CODEX_DB_PATH: "/tmp/tele-codex-test.db"
    });

    expect(config.controllerUserId).toBe(1);
    expect(config.allowSessionGrants).toBe(false);
    expect(config.rpcTimeoutMs).toBe(30_000);
    expect(config.appServerMaxReconnectAttempts).toBe(8);
    expect(config.rateLimitWarnPercent).toBe(80);
    expect(config.tmuxSubmitKey).toBe("enter");
    expect(config.tmuxPasteSettleMs).toBe(250);
    expect(config.transcriptRetentionDays).toBeUndefined();
    expect(config.workspaceRoot.endsWith("/Workspace")).toBe(true);
  });

  it("parses an opt-in transcript retention window in days", () => {
    const config = loadConfig({
      TELE_CODEX_BOT_TOKEN: "token",
      TELE_CODEX_ALLOWED_USER_IDS: "1",
      TELE_CODEX_TRANSCRIPT_RETENTION_DAYS: "30"
    });

    expect(config.transcriptRetentionDays).toBe(30);
    expect(() => loadConfig({
      TELE_CODEX_BOT_TOKEN: "token",
      TELE_CODEX_ALLOWED_USER_IDS: "1",
      TELE_CODEX_TRANSCRIPT_RETENTION_DAYS: "0"
    })).toThrow();
  });

  it("rejects zero or multiple Controllers", () => {
    expect(() => loadConfig({
      TELE_CODEX_BOT_TOKEN: "token",
      TELE_CODEX_ALLOWED_USER_IDS: "1,2"
    })).toThrow(/exactly one/);
    expect(() => loadConfig({
      TELE_CODEX_BOT_TOKEN: "token",
      TELE_CODEX_ALLOWED_USER_IDS: ""
    })).toThrow();
  });

  it("inspects invalid configuration without creating the database directory", () => {
    const dbPath = join(tmpdir(), `tele-codex-doctor-missing-${process.pid}-${Date.now()}`, "db.sqlite");
    const inspection = inspectConfig({ TELE_CODEX_DB_PATH: dbPath });

    expect(inspection.config).toBeUndefined();
    expect(inspection.botTokenConfigured).toBe(false);
    expect(inspection.controllerCount).toBe(0);
    expect(inspection.errors.length).toBeGreaterThan(0);
    expect(existsSync(dirname(dbPath))).toBe(false);
  });
});
