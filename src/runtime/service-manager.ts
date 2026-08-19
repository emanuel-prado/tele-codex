import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ServiceManagerOptions {
  home?: string;
  cwd?: string;
  nodePath?: string;
  cliPath?: string;
  user?: string;
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
  private readonly runCommand: NonNullable<ServiceManagerOptions["runCommand"]>;
  private readonly wait: NonNullable<ServiceManagerOptions["wait"]>;
  private readonly updateHealthAttempts: number;

  constructor(options: ServiceManagerOptions = {}) {
    this.home = options.home ?? homedir();
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.nodePath = resolve(options.nodePath ?? process.execPath);
    this.cliPath = resolve(options.cliPath ?? process.argv[1] ?? "dist/cli.js");
    this.user = options.user ?? process.env.USER ?? "";
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
    const path = this.unitPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, renderUnit({
      cwd: this.cwd,
      nodePath: this.nodePath,
      cliPath: this.cliPath,
      envFile: resolve(envFile)
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

export function renderUnit(input: { cwd: string; nodePath: string; cliPath: string; envFile: string }): string {
  return [
    "[Unit]",
    "Description=tele-codex Telegram companion",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdPathValue(input.cwd)}`,
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
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
