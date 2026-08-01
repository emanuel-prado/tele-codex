import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectConfig, type AppConfig } from "../config.js";
import Database from "better-sqlite3";
import { ServiceManager, type ServiceStatus } from "./service-manager.js";
import { APP_SERVER_CONTRACT_VERSION } from "../adapters/app-server-contract.js";

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
    configCheck("Controller", Number.isSafeInteger(config.controllerUserId), `user ${config.controllerUserId}`)
  ];

  checks.push(await directoryCheck("Workspace root", config.workspaceRoot));
  checks.push(await writableDirectoryCheck("Database directory", dirname(config.dbPath)));
  checks.push(await (options.databaseCheck ?? (() => databaseIntegrityCheck(config.dbPath)))());
  const codex = await commandCheck("Codex CLI", config.codexCommand, ["--version"], runCommand);
  checks.push(codex);
  const appServer = await commandCheck("Codex app-server", config.codexCommand, ["app-server", "--help"], runCommand);
  checks.push(appServer.status === "pass"
    ? { ...appServer, detail: `installed ${codex.detail}; checked contract ${APP_SERVER_CONTRACT_VERSION}` }
    : appServer);
  checks.push(await optionalCommandCheck("tmux fallback", "tmux", ["-V"], runCommand));
  checks.push(await serviceCheck(options.serviceStatus ?? (() => new ServiceManager().status())));

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks
  };
}

export async function runDoctorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: DoctorOptions = {}
): Promise<DoctorReport> {
  const inspection = inspectConfig(env);
  if (inspection.config) return runDoctor(inspection.config, options);
  const checks: HealthCheck[] = [
    nodeCheck(),
    configCheck("Telegram bot token", inspection.botTokenConfigured, "configured"),
    configCheck(
      "Controller",
      inspection.controllerCount === 1,
      inspection.controllerCount === undefined ? "invalid numeric ID" : `${inspection.controllerCount} configured`
    ),
    {
      name: "Configuration",
      status: "fail",
      detail: inspection.errors.join("; ") || "missing or invalid"
    },
    {
      name: "Runtime checks",
      status: "warn",
      detail: "skipped until configuration is valid"
    }
  ];
  return { ok: false, checks };
}

async function databaseIntegrityCheck(path: string): Promise<HealthCheck> {
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    const rows = db.pragma("quick_check") as Array<{ quick_check: string }>;
    const migrationTable = db.prepare("select name from sqlite_master where type = 'table' and name = 'schema_migrations'").get();
    const version = migrationTable
      ? Number((db.prepare("select coalesce(max(version), 0) as version from schema_migrations").get() as { version: number }).version)
      : 0;
    const pageCount = Number(db.pragma("page_count", { simple: true }));
    const pageSize = Number(db.pragma("page_size", { simple: true }));
    const databaseBytes = pageCount * pageSize;
    const walBytes = await fileSize(`${path}-wal`);
    db.close();
    const ok = rows.every((row) => row.quick_check === "ok");
    const excessive = databaseBytes > 256 * 1024 * 1024 || walBytes > 64 * 1024 * 1024;
    const detail = `schema v${version}, database ${mb(databaseBytes)}, WAL ${mb(walBytes)}`;
    return {
      name: "Database integrity",
      status: ok ? (excessive ? "warn" : "pass") : "fail",
      detail: ok ? `${detail}${excessive ? "; run maintenance/checkpoint" : ""}` : JSON.stringify(rows)
    };
  } catch (error) {
    return { name: "Database integrity", status: "fail", detail: error instanceof Error ? error.message : "check failed" };
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
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
