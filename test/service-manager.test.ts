import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { renderUnit, ServiceManager } from "../src/runtime/service-manager.js";

describe("ServiceManager", () => {
  it("renders a restartable, private user unit", () => {
    const unit = renderUnit({
      cwd: "/work/repo", nodePath: "/usr/bin/node", cliPath: "/work/repo/dist/cli.js",
      envFile: "/work/repo/.env", codexPath: "/home/test/.local/bin/codex"
    });
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("WorkingDirectory=/work/repo");
    expect(unit).not.toContain('WorkingDirectory="/work/repo"');
    expect(unit).toContain("--env-file \"/work/repo/.env\"");
    expect(unit).toContain('Environment="TELE_CODEX_CODEX_COMMAND=/home/test/.local/bin/codex"');
  });

  it("escapes a WorkingDirectory value without wrapping the directive in quotes", () => {
    const unit = renderUnit({
      cwd: "/work/tele codex%preview",
      nodePath: "/usr/bin/node",
      cliPath: "/work/repo/dist/cli.js",
      envFile: "/work/repo/.env",
      codexPath: '/home/test/Codex Builds/100%/codex"preview'
    });

    expect(unit).toContain("WorkingDirectory=/work/tele\\x20codex%%preview");
    expect(unit).toContain('ExecStart="/usr/bin/node" "/work/repo/dist/cli.js" --env-file "/work/repo/.env"');
    expect(unit).toContain('Environment="TELE_CODEX_CODEX_COMMAND=/home/test/Codex Builds/100%%/codex\\"preview"');
  });

  it("resolves a Codex executable from the invoking PATH and pins its absolute path", async () => {
    const home = await mkdtemp(join(tmpdir(), "tele-codex-service-path-"));
    const bin = join(home, ".local", "bin");
    const command = join(bin, "codex");
    await mkdir(bin, { recursive: true });
    await writeFile(command, "#!/bin/sh\nexit 0\n");
    await chmod(command, 0o755);
    const manager = new ServiceManager({
      home,
      cwd: "/work/repo",
      nodePath: "/usr/bin/node",
      cliPath: "/work/repo/dist/cli.js",
      codexCommand: "codex",
      pathEnv: bin,
      user: "tester",
      runCommand: successfulCommand
    });

    await manager.install("/work/repo/.env");

    expect(await readFile(manager.unitPath(), "utf8"))
      .toContain(`Environment=\"TELE_CODEX_CODEX_COMMAND=${command}\"`);
  });

  it.each([
    ["missing command", "/missing/codex"],
    ["non-executable command", "codex"]
  ])("rejects a %s before installing or starting the service", async (_label, configuredCommand) => {
    const home = await mkdtemp(join(tmpdir(), "tele-codex-service-invalid-"));
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    if (configuredCommand === "codex") await writeFile(join(bin, "codex"), "not executable\n");
    const calls: string[] = [];
    const manager = new ServiceManager({
      home,
      cwd: "/work/repo",
      cliPath: "/work/repo/dist/cli.js",
      codexCommand: configuredCommand,
      pathEnv: bin,
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        return { stdout: "", stderr: "" };
      }
    });

    await expect(manager.install("/work/repo/.env")).rejects.toThrow(/Codex executable.*(not found|not executable)/i);
    await expect(readFile(manager.unitPath(), "utf8")).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("installs and enables the user service", async () => {
    const home = await mkdtemp(join(tmpdir(), "tele-codex-service-"));
    const calls: string[] = [];
    const manager = new ServiceManager({
      home,
      cwd: "/work/repo",
      nodePath: "/usr/bin/node",
      cliPath: "/work/repo/dist/cli.js",
      codexCommand: process.execPath,
      user: "tester",
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "loginctl") return { stdout: "yes\n", stderr: "" };
        return { stdout: "", stderr: "" };
      }
    });

    const status = await manager.install("/work/repo/.env");
    const unit = await readFile(manager.unitPath(), "utf8");
    expect(status).toMatchObject({ installed: true, active: true, enabled: true, linger: true });
    expect(unit).toContain("/work/repo/dist/cli.js");
    expect(calls).toContain("systemctl --user enable --now tele-codex.service");
  });

  it("builds before restart and waits for a stable active PID", async () => {
    const home = await mkdtemp(join(tmpdir(), "tele-codex-service-update-"));
    const envFile = join(home, 'custom % "environment.env');
    await writeFile(envFile, `TELE_CODEX_CODEX_COMMAND=${process.execPath}\n`);
    const calls: string[] = [];
    const manager = new ServiceManager({
      home,
      cwd: "/work/repo",
      nodePath: "/usr/bin/node",
      cliPath: "/work/repo/dist/cli.js",
      codexCommand: process.execPath,
      user: "tester",
      wait: async () => {},
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "systemctl" && args.includes("MainPID")) return { stdout: "4242\n", stderr: "" };
        if (command === "loginctl") return { stdout: "yes\n", stderr: "" };
        return { stdout: "", stderr: "" };
      }
    });

    await manager.install(envFile);
    calls.length = 0;

    await manager.update();

    expect(calls.slice(0, 3)).toEqual([
      "npm --prefix /work/repo run build",
      "systemctl --user daemon-reload",
      "systemctl --user restart tele-codex.service"
    ]);
    const escapedEnvFile = envFile.replace(/%/g, "%%").replace(/"/g, '\\"');
    expect(await readFile(manager.unitPath(), "utf8")).toContain(`--env-file \"${escapedEnvFile}\"`);
    expect(calls.filter((call) => call.includes("MainPID"))).toHaveLength(2);
  });

  it("does not restart when the update build fails", async () => {
    const calls: string[] = [];
    const manager = new ServiceManager({
      cwd: "/work/repo",
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        throw new Error("build failed");
      }
    });

    await expect(manager.update()).rejects.toThrow("build failed");
    expect(calls).toEqual(["npm --prefix /work/repo run build"]);
  });

  it("does not replace or restart an installed service when update validation fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "tele-codex-service-validation-"));
    const envFile = join(home, "custom.env");
    await writeFile(envFile, `TELE_CODEX_CODEX_COMMAND=${process.execPath}\n`);
    const calls: string[] = [];
    const manager = new ServiceManager({
      home,
      cwd: "/work/repo",
      nodePath: "/usr/bin/node",
      cliPath: "/work/repo/dist/cli.js",
      codexCommand: process.execPath,
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        return { stdout: "", stderr: "" };
      }
    });
    await manager.install(envFile);
    const installed = await readFile(manager.unitPath(), "utf8");
    await writeFile(envFile, "TELE_CODEX_CODEX_COMMAND=/missing/codex\n");
    calls.length = 0;

    await expect(manager.update()).rejects.toThrow(/Codex executable.*not found/i);

    expect(await readFile(manager.unitPath(), "utf8")).toBe(installed);
    expect(calls).toEqual(["npm --prefix /work/repo run build"]);
  });

  it("reports an actionable error when the restarted service never becomes healthy", async () => {
    const home = await mkdtemp(join(tmpdir(), "tele-codex-service-unhealthy-"));
    const envFile = join(home, ".env");
    await writeFile(envFile, `TELE_CODEX_CODEX_COMMAND=${process.execPath}\n`);
    const manager = new ServiceManager({
      home,
      cwd: "/work/repo",
      cliPath: "/work/repo/dist/cli.js",
      codexCommand: process.execPath,
      updateHealthAttempts: 2,
      wait: async () => {},
      runCommand: async (command, args) => {
        if (command === "systemctl" && args.includes("is-active")) throw new Error("inactive");
        return { stdout: "", stderr: "" };
      }
    });

    await manager.install(envFile);

    await expect(manager.update()).rejects.toThrow(/journalctl --user -u tele-codex/i);
  });
});

async function successfulCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  if (command === "loginctl") return { stdout: "yes\n", stderr: "" };
  if (command === "systemctl" && args.includes("MainPID")) return { stdout: "4242\n", stderr: "" };
  return { stdout: "", stderr: "" };
}
