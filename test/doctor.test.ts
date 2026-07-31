import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { formatDoctorReport, runDoctor } from "../src/runtime/doctor.js";
import type { AppConfig } from "../src/config.js";

describe("doctor", () => {
  it("reports healthy required checks and warns for missing optional tmux", async () => {
    const root = await mkdtemp(join(tmpdir(), "tele-codex-doctor-workspace-"));
    const dbDir = await mkdtemp(join(tmpdir(), "tele-codex-doctor-db-"));
    const report = await runDoctor(config(root, join(dbDir, "db.sqlite")), {
      runCommand: async (command, args) => {
        if (command === "tmux") throw new Error("not found");
        return { stdout: args.includes("--version") ? "codex 1.0.0\n" : "app-server help\n", stderr: "" };
      },
      serviceStatus: healthyService
    });

    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.name === "tmux fallback")?.status).toBe("warn");
    expect(formatDoctorReport(report)).toContain("tele-codex doctor: ok");
  });

  it("fails when required Codex checks fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "tele-codex-doctor-workspace-"));
    const dbDir = await mkdtemp(join(tmpdir(), "tele-codex-doctor-db-"));
    const report = await runDoctor(config(root, join(dbDir, "db.sqlite")), {
      runCommand: async () => {
        throw new Error("missing command");
      },
      serviceStatus: healthyService
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "Codex CLI")?.status).toBe("fail");
  });
});

function config(workspaceRoot: string, dbPath: string): AppConfig {
  return {
    botToken: "token",
    allowedUserIds: new Set([1]),
    allowedChatIds: new Set(),
    dbPath,
    logLevel: "info",
    approvalTimeoutMs: 900000,
    rpcTimeoutMs: 30000,
    rateLimitWarnPercent: 80,
    allowSessionGrants: true,
    codexCommand: "codex",
    tmuxSubmitKey: "enter",
    tmuxPasteSettleMs: 250,
    workspaceRoot
  };
}

async function healthyService() {
  return { installed: true, active: true, enabled: true, linger: true, detail: "ok" };
}
