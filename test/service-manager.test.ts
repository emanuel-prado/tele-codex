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
    expect(unit).toContain("--env-file \"/work/repo/.env\"");
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
});
