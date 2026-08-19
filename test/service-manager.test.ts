import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { renderUnit, ServiceManager } from "../src/runtime/service-manager.js";

describe("ServiceManager", () => {
  it("renders a restartable, private user unit", () => {
    const unit = renderUnit({ cwd: "/work/repo", nodePath: "/usr/bin/node", cliPath: "/work/repo/dist/cli.js", envFile: "/work/repo/.env" });
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("WorkingDirectory=/work/repo");
    expect(unit).not.toContain('WorkingDirectory="/work/repo"');
    expect(unit).toContain("--env-file \"/work/repo/.env\"");
  });

  it("escapes a WorkingDirectory value without wrapping the directive in quotes", () => {
    const unit = renderUnit({
      cwd: "/work/tele codex%preview",
      nodePath: "/usr/bin/node",
      cliPath: "/work/repo/dist/cli.js",
      envFile: "/work/repo/.env"
    });

    expect(unit).toContain("WorkingDirectory=/work/tele\\x20codex%%preview");
    expect(unit).toContain('ExecStart="/usr/bin/node" "/work/repo/dist/cli.js" --env-file "/work/repo/.env"');
  });

  it("installs and enables the user service", async () => {
    const home = await mkdtemp(join(tmpdir(), "tele-codex-service-"));
    const calls: string[] = [];
    const manager = new ServiceManager({
      home,
      cwd: "/work/repo",
      nodePath: "/usr/bin/node",
      cliPath: "/work/repo/dist/cli.js",
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
    const calls: string[] = [];
    const manager = new ServiceManager({
      cwd: "/work/repo",
      user: "tester",
      wait: async () => {},
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "systemctl" && args.includes("MainPID")) return { stdout: "4242\n", stderr: "" };
        if (command === "loginctl") return { stdout: "yes\n", stderr: "" };
        return { stdout: "", stderr: "" };
      }
    });

    await manager.update();

    expect(calls.slice(0, 2)).toEqual([
      "npm --prefix /work/repo run build",
      "systemctl --user restart tele-codex.service"
    ]);
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

  it("reports an actionable error when the restarted service never becomes healthy", async () => {
    const manager = new ServiceManager({
      cwd: "/work/repo",
      updateHealthAttempts: 2,
      wait: async () => {},
      runCommand: async (command, args) => {
        if (command === "systemctl" && args.includes("is-active")) throw new Error("inactive");
        return { stdout: "", stderr: "" };
      }
    });

    await expect(manager.update()).rejects.toThrow(/journalctl --user -u tele-codex/i);
  });
});
