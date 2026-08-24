import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ServiceManagerOptions {
  home?: string;
  cwd?: string;
  nodePath?: string;
  cliPath?: string;
  user?: string;
  codexCommand?: string;
  pathEnv?: string;
  runCommand?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  wait?: (ms: number) => Promise<void>;
  updateHealthAttempts?: number;
}

export interface ServiceStatus {
  installed: boolean;
  active: boolean;
  enabled: boolean;
  linger: boolean;
  detail: string;
}

export class ServiceManager {
  private readonly home: string;
  private readonly cwd: string;
  private readonly nodePath: string;
  private readonly cliPath: string;
  private readonly user: string;
  private readonly codexCommand: string;
  private readonly pathEnv: string;
  private readonly runCommand: NonNullable<ServiceManagerOptions["runCommand"]>;
  private readonly wait: NonNullable<ServiceManagerOptions["wait"]>;
  private readonly updateHealthAttempts: number;

  constructor(options: ServiceManagerOptions = {}) {
    this.home = options.home ?? homedir();
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.nodePath = resolve(options.nodePath ?? process.execPath);
    this.cliPath = resolve(options.cliPath ?? process.argv[1] ?? "dist/cli.js");
    this.user = options.user ?? process.env.USER ?? "";
    this.codexCommand = options.codexCommand ?? process.env.TELE_CODEX_CODEX_COMMAND ?? "codex";
    this.pathEnv = options.pathEnv ?? process.env.PATH ?? "";
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.updateHealthAttempts = options.updateHealthAttempts ?? 10;
  }

  unitPath(): string {
    return join(this.home, ".config", "systemd", "user", "tele-codex.service");
  }

  async install(envFile = join(this.cwd, ".env")): Promise<ServiceStatus> {
    if (!this.cliPath.endsWith(".js")) {
      throw new Error("Build tele-codex and run the compiled dist/cli.js before installing the service.");
    }
    const codexPath = await resolveExecutable(this.codexCommand, this.pathEnv, this.cwd);
    const path = this.unitPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, renderUnit({
      cwd: this.cwd,
      nodePath: this.nodePath,
      cliPath: this.cliPath,
      envFile: resolve(envFile),
      codexPath
    }), { mode: 0o600 });
    await this.runCommand("systemctl", ["--user", "daemon-reload"]);
    await this.runCommand("systemctl", ["--user", "enable", "--now", "tele-codex.service"]);
    return this.status();
  }

  async uninstall(): Promise<void> {
    await this.runCommand("systemctl", ["--user", "disable", "--now", "tele-codex.service"]).catch(() => undefined);
    await unlink(this.unitPath()).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await this.runCommand("systemctl", ["--user", "daemon-reload"]);
  }

  async update(): Promise<ServiceStatus> {
    await this.runCommand("npm", ["--prefix", this.cwd, "run", "build"]);
    const path = this.unitPath();
    const installedUnit = await readFile(path, "utf8").catch(() => {
      throw new Error("tele-codex service is not installed. Run service install first.");
    });
    const envFile = installedEnvironmentFile(installedUnit);
    if (!envFile) {
      throw new Error("The installed tele-codex service does not identify its environment file. Reinstall the service before updating.");
    }
    const configuredCommand = await configuredCodexCommand(envFile);
    const codexPath = await resolveExecutable(configuredCommand, this.pathEnv, this.cwd);
    await replaceFile(path, renderUnit({
      cwd: this.cwd,
      nodePath: this.nodePath,
      cliPath: this.cliPath,
      envFile,
      codexPath
    }));
    await this.runCommand("systemctl", ["--user", "daemon-reload"]);
    await this.runCommand("systemctl", ["--user", "restart", "tele-codex.service"]);
    let stablePid: string | undefined;
    let stableChecks = 0;
    for (let attempt = 0; attempt < this.updateHealthAttempts; attempt += 1) {
      const active = await commandOk(this.runCommand, "systemctl", ["--user", "is-active", "--quiet", "tele-codex.service"]);
      const pid = active
        ? (await this.runCommand("systemctl", ["--user", "show", "tele-codex.service", "--property", "MainPID", "--value"])
            .then((result) => result.stdout.trim())
            .catch(() => ""))
        : "";
      if (active && pid && pid !== "0") {
        stableChecks = pid === stablePid ? stableChecks + 1 : 1;
        stablePid = pid;
        if (stableChecks >= 2) return this.status();
      } else {
        stablePid = undefined;
        stableChecks = 0;
      }
      await this.wait(1_000);
    }
    throw new Error("Service update built successfully, but tele-codex did not remain active with a stable PID. Check: journalctl --user -u tele-codex.service");
  }

  async status(): Promise<ServiceStatus> {
    const installed = await readFile(this.unitPath(), "utf8").then(() => true).catch(() => false);
    const active = await commandOk(this.runCommand, "systemctl", ["--user", "is-active", "--quiet", "tele-codex.service"]);
    const enabled = await commandOk(this.runCommand, "systemctl", ["--user", "is-enabled", "--quiet", "tele-codex.service"]);
    const lingerResult = this.user
      ? await this.runCommand("loginctl", ["show-user", this.user, "-p", "Linger", "--value"]).catch(() => ({ stdout: "", stderr: "" }))
      : { stdout: "", stderr: "" };
    const linger = lingerResult.stdout.trim() === "yes";
    const issues = [
      installed ? undefined : "service unit is not installed",
      enabled ? undefined : "service is not enabled",
      active ? undefined : "service is not active",
      linger ? undefined : `enable boot persistence with: loginctl enable-linger ${this.user || "$USER"}`
    ].filter(Boolean);
    return {
      installed,
      active,
      enabled,
      linger,
      detail: issues.length === 0 ? "Service is active and configured to survive logout and boot." : issues.join("; ")
    };
  }
}

export function renderUnit(input: {
  cwd: string;
  nodePath: string;
  cliPath: string;
  envFile: string;
  codexPath: string;
}): string {
  return [
    "[Unit]",
    "Description=tele-codex Telegram companion",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdPathValue(input.cwd)}`,
    `Environment=${systemdQuote(`TELE_CODEX_CODEX_COMMAND=${input.codexPath}`)}`,
    `ExecStart=${systemdQuote(input.nodePath)} ${systemdQuote(input.cliPath)} --env-file ${systemdQuote(input.envFile)}`,
    "Restart=on-failure",
    "RestartSec=5s",
    "KillMode=control-group",
    "TimeoutStopSec=20s",
    "UMask=0077",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

function systemdQuote(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/%/g, "%%")}"`;
}

function systemdPathValue(value: string): string {
  const escapes: Record<string, string> = {
    " ": "\\x20",
    "\t": "\\t",
    "\n": "\\n",
    "\r": "\\r",
    "\\": "\\\\",
    '"': "\\x22",
    "'": "\\x27",
    "%": "%%"
  };
  return [...value].map((character) => escapes[character] ?? character).join("");
}

async function commandOk(
  run: NonNullable<ServiceManagerOptions["runCommand"]>,
  command: string,
  args: string[]
): Promise<boolean> {
  return run(command, args).then(() => true).catch(() => false);
}

async function defaultRunCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, { timeout: 15_000 });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function resolveExecutable(command: string, pathEnv: string, cwd: string): Promise<string> {
  const configured = command.trim();
  if (!configured) throw executableError("not found");
  if (isAbsolute(configured)) {
    await validateExecutable(configured);
    return configured;
  }
  if (configured.includes("/") || configured.includes("\\")) {
    const candidate = resolve(cwd, configured);
    await validateExecutable(candidate);
    return candidate;
  }
  let foundNonExecutable = false;
  for (const directory of pathEnv.split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, configured);
    try {
      const metadata = await stat(candidate);
      if (!metadata.isFile()) {
        foundNonExecutable = true;
        continue;
      }
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") foundNonExecutable = true;
    }
  }
  throw executableError(foundNonExecutable ? "not executable" : "not found");
}

async function validateExecutable(path: string): Promise<void> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw executableError("not executable");
    await access(path, constants.X_OK);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Configured Codex executable")) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw executableError(code === "ENOENT" ? "not found" : "not executable");
  }
}

function executableError(reason: "not found" | "not executable"): Error {
  return new Error(
    `Configured Codex executable is ${reason}. Set TELE_CODEX_CODEX_COMMAND to an executable absolute path or a command available on the invoking user's PATH.`
  );
}

async function configuredCodexCommand(envFile: string): Promise<string> {
  const contents = await readFile(envFile, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0 || line.slice(0, separator).trim() !== "TELE_CODEX_CODEX_COMMAND") continue;
    const value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  }
  return "codex";
}

function installedEnvironmentFile(unit: string): string | undefined {
  const execStart = unit.split(/\r?\n/).find((line) => line.startsWith("ExecStart="));
  if (!execStart) return undefined;
  const words = parseSystemdWords(execStart.slice("ExecStart=".length));
  const flag = words.indexOf("--env-file");
  return flag >= 0 ? words[flag + 1] : undefined;
}

function parseSystemdWords(value: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "\\" && index + 1 < value.length) {
      word += value[++index];
    } else if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (word) {
        words.push(word.replace(/%%/g, "%"));
        word = "";
      }
    } else {
      word += character;
    }
  }
  if (word) words.push(word.replace(/%%/g, "%"));
  return words;
}

async function replaceFile(path: string, contents: string): Promise<void> {
  const candidate = `${path}.new`;
  await writeFile(candidate, contents, { mode: 0o600 });
  try {
    await rename(candidate, path);
  } catch (error) {
    await unlink(candidate).catch(() => undefined);
    throw error;
  }
}
