import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "../config.js";
import Database from "better-sqlite3";
import { ServiceManager, type ServiceStatus } from "./service-manager.js";

const execFileAsync = promisify(execFile);

export type HealthStatus = "pass" | "warn" | "fail";

export interface HealthCheck {
  name: string;
  status: HealthStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: HealthCheck[];
}

export interface DoctorOptions {
  runCommand?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  serviceStatus?: () => Promise<ServiceStatus>;
  databaseCheck?: () => Promise<HealthCheck>;
}

export async function runDoctor(config: AppConfig, options: DoctorOptions = {}): Promise<DoctorReport> {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const checks: HealthCheck[] = [
    nodeCheck(),
    configCheck("Telegram bot token", Boolean(config.botToken && !config.botToken.includes("replace-")), "configured"),
    configCheck("Allowed users", config.allowedUserIds.size > 0, `${config.allowedUserIds.size} user(s)`)
  ];

  checks.push(await directoryCheck("Workspace root", config.workspaceRoot));
  checks.push(await writableDirectoryCheck("Database directory", dirname(config.dbPath)));
  checks.push(await (options.databaseCheck ?? (() => databaseIntegrityCheck(config.dbPath)))());
  checks.push(await commandCheck("Codex CLI", config.codexCommand, ["--version"], runCommand));
  checks.push(await commandCheck("Codex app-server", config.codexCommand, ["app-server", "--help"], runCommand));
  checks.push(await optionalCommandCheck("tmux fallback", "tmux", ["-V"], runCommand));
  checks.push(await serviceCheck(options.serviceStatus ?? (() => new ServiceManager().status())));

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks
  };
}

async function databaseIntegrityCheck(path: string): Promise<HealthCheck> {
  try {
    const db = new Database(path);
    const rows = db.pragma("quick_check") as Array<{ quick_check: string }>;
    db.close();
    const ok = rows.every((row) => row.quick_check === "ok");
    return { name: "Database integrity", status: ok ? "pass" : "fail", detail: ok ? "ok" : JSON.stringify(rows) };
  } catch (error) {
    return { name: "Database integrity", status: "fail", detail: error instanceof Error ? error.message : "check failed" };
  }
}

async function serviceCheck(readStatus: () => Promise<ServiceStatus>): Promise<HealthCheck> {
  try {
    const status = await readStatus();
    const ok = status.installed && status.active && status.enabled && status.linger;
    return {
      name: "Unattended service",
      status: ok ? "pass" : "fail",
      detail: ok ? "installed, active, enabled, linger on" : status.detail
    };
  } catch (error) {
    return { name: "Unattended service", status: "fail", detail: error instanceof Error ? error.message : "status failed" };
  }
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    report.ok ? "tele-codex doctor: ok" : "tele-codex doctor: attention needed",
    "",
    ...report.checks.map((check) => `${symbol(check.status)} ${check.name}: ${check.detail}`)
  ];
  return lines.join("\n");
}

function nodeCheck(): HealthCheck {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    name: "Node.js",
    status: major >= 22 ? "pass" : "fail",
    detail: `${process.versions.node}${major >= 22 ? "" : " (requires >=22)"}`
  };
}

function configCheck(name: string, ok: boolean, detail: string): HealthCheck {
  return { name, status: ok ? "pass" : "fail", detail: ok ? detail : "missing or invalid" };
}

async function directoryCheck(name: string, path: string): Promise<HealthCheck> {
  try {
    const info = await stat(path);
    return { name, status: info.isDirectory() ? "pass" : "fail", detail: info.isDirectory() ? path : `not a directory: ${path}` };
  } catch (error) {
    return { name, status: "fail", detail: error instanceof Error ? error.message : `cannot access ${path}` };
  }
}

async function writableDirectoryCheck(name: string, path: string): Promise<HealthCheck> {
  try {
    await access(path, constants.W_OK);
    return { name, status: "pass", detail: path };
  } catch (error) {
    return { name, status: "fail", detail: error instanceof Error ? error.message : `not writable: ${path}` };
  }
}

async function commandCheck(
  name: string,
  command: string,
  args: string[],
  runCommand: NonNullable<DoctorOptions["runCommand"]>
): Promise<HealthCheck> {
  try {
    const result = await runCommand(command, args);
    const detail = firstLine(result.stdout || result.stderr) || `${command} ${args.join(" ")} ok`;
    return { name, status: "pass", detail };
  } catch (error) {
    return { name, status: "fail", detail: error instanceof Error ? error.message : `${command} failed` };
  }
}

async function optionalCommandCheck(
  name: string,
  command: string,
  args: string[],
  runCommand: NonNullable<DoctorOptions["runCommand"]>
): Promise<HealthCheck> {
  const result = await commandCheck(name, command, args, runCommand);
  return result.status === "fail" ? { ...result, status: "warn", detail: `${result.detail} (only needed for tmux fallback)` } : result;
}

async function defaultRunCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, { timeout: 10_000 });
  return { stdout: result.stdout, stderr: result.stderr };
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function symbol(status: HealthStatus): string {
  if (status === "pass") return "OK";
  if (status === "warn") return "WARN";
  return "FAIL";
}
