import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TELEGRAM_COMMAND_CATALOG } from "../src/telegram/command-catalog.js";

const root = resolve(import.meta.dirname, "..");

describe("README documentation", () => {
  it("uses accessible theme-specific local wordmarks", async () => {
    const readme = await read("README.md");

    expect(readme).toContain('media="(prefers-color-scheme: dark)" srcset="assets/brand/tele-codex-wordmark-dark.png"');
    expect(readme).toContain('media="(prefers-color-scheme: light)" srcset="assets/brand/tele-codex-wordmark-light.png"');
    expect(readme).toContain('alt="tele-codex" width="720"');

    for (const theme of ["light", "dark"]) {
      const source = `assets/brand/tele-codex-wordmark-${theme}.svg`;
      const rendered = `assets/brand/tele-codex-wordmark-${theme}.png`;
      const svg = await read(source);
      const png = await readBinary(rendered);
      const info = await stat(resolve(root, rendered));

      expect(svg).toContain('viewBox="0 0 1200 300"');
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect(png.readUInt32BE(16)).toBe(1200);
      expect(png.readUInt32BE(20)).toBe(300);
      expect(png[25]).toBe(6);
      expect(info.size).toBeLessThan(250_000);
    }
  });

  it("keeps the same geometry in both colour variants", async () => {
    const light = await read("assets/brand/tele-codex-wordmark-light.svg");
    const dark = await read("assets/brand/tele-codex-wordmark-dark.svg");

    expect(svgGeometry(dark)).toEqual(svgGeometry(light));
    expect(dark).not.toBe(light);
  });

  it("links useful badges to their canonical sources", async () => {
    const readme = await read("README.md");

    expect(readme).toContain("https://github.com/emanuel-prado/tele-codex/actions/workflows/ci.yml/badge.svg");
    expect(readme).toContain('href="https://github.com/emanuel-prado/tele-codex/actions/workflows/ci.yml"');
    expect(readme).toContain("contracts%2Fapp-server%2Fcontract.json&amp;query=%24.codexVersion");
    expect(readme).toContain('href="docs/app-server-contract-testing.md"');
    expect(readme).toContain("package.json&amp;query=%24.engines.node");
    expect(readme).toContain('href="package.json"');
    expect(readme).not.toMatch(/codex-cli%20\d|tested%20Codex-[\d.]/);
  });

  it("has valid local image and link targets", async () => {
    const readme = await read("README.md");
    const paths = [
      ...matches(readme, /(?:src|srcset|href)="((?!https?:|#)[^"]+)"/g),
      ...matches(readme, /!?(?:\[[^\]]*\])\(((?!https?:|#)[^)]+)\)/g)
    ].map((value) => value.split("#", 1)[0]!).filter(Boolean);

    expect(paths.length).toBeGreaterThan(0);
    for (const path of new Set(paths)) {
      await expect(stat(resolve(root, path))).resolves.toBeDefined();
    }
  });

  it("links every local README and handbook target, including anchors", async () => {
    for (const source of ["README.md", "docs/user-guide.md"]) {
      const markdown = await read(source);
      const links = matches(markdown, /!?(?:\[[^\]]*\])\(((?!https?:)[^)]+)\)/g);
      for (const link of links) {
        const [rawPath, anchor] = link.split("#", 2);
        const target = rawPath
          ? resolve(root, dirname(source), rawPath)
          : resolve(root, source);
        await expect(stat(target), `${source}: ${link}`).resolves.toBeDefined();
        if (anchor) {
          const targetMarkdown = await readRelative(target);
          expect(markdownAnchors(targetMarkdown), `${source}: ${link}`).toContain(anchor);
        }
      }
    }
  });

  it("documents exactly one row for every registered root command", async () => {
    const guide = await read("docs/user-guide.md");
    const commandSection = guide.split("## Telegram command reference\n", 2)[1] ?? "";
    const documented = matches(commandSection, /^\| `\/([a-z]+)` \|/gm);
    const registered = TELEGRAM_COMMAND_CATALOG.map(({ command }) => command);

    expect(new Set(documented).size).toBe(documented.length);
    expect([...documented].sort()).toEqual([...registered].sort());
  });

  it("documents the supported configuration surface and keeps the remote token blank", async () => {
    const guide = await read("docs/user-guide.md");
    const configSection = guide.split("### Configuration reference\n", 2)[1]?.split("### Advanced Telegram groups", 1)[0] ?? "";
    const documented = matches(configSection, /^\| `([^`]+)` \|/gm);
    const expected = [
      "TELE_CODEX_BOT_TOKEN",
      "TELE_CODEX_ALLOWED_USER_IDS",
      "TELE_CODEX_ALLOWED_CHAT_IDS",
      "TELE_CODEX_DB_PATH",
      "TELE_CODEX_LOG_LEVEL",
      "TELE_CODEX_APPROVAL_TIMEOUT_MS",
      "TELE_CODEX_RPC_TIMEOUT_MS",
      "TELE_CODEX_APP_SERVER_MAX_RECONNECT_ATTEMPTS",
      "TELE_CODEX_RATE_LIMIT_WARN_PERCENT",
      "TELE_CODEX_TRANSCRIPT_RETENTION_DAYS",
      "TELE_CODEX_ALLOW_SESSION_GRANTS",
      "TELE_CODEX_CODEX_COMMAND",
      "TELE_CODEX_WORKSPACE_ROOT",
      "TELE_CODEX_APP_SERVER_URL",
      "TELE_CODEX_APP_SERVER_TOKEN",
      "TELE_CODEX_ENV_FILE",
      "--env-file PATH"
    ];

    expect(documented).toEqual(expected);
    expect(await read(".env.example")).toMatch(/^TELE_CODEX_APP_SERVER_TOKEN=$/m);
  });

  it("keeps release metadata synchronized and documents the protected branch flow", async () => {
    const packageJson = JSON.parse(await read("package.json")) as { version: string };
    const packageLock = JSON.parse(await read("package-lock.json")) as {
      packages: Record<string, { version?: string }>;
      version: string;
    };
    const releaseManifest = JSON.parse(await read(".release-please-manifest.json")) as Record<string, string>;
    const versioning = await read("docs/versioning.md");
    const agentRules = await read("AGENTS.md");

    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[""]?.version).toBe(packageJson.version);
    expect(releaseManifest["."]).toBe(packageJson.version);
    expect(versioning).toContain("`develop` is the default integration branch");
    expect(versioning).toContain("`master` is the stable release branch");
    expect(agentRules).toContain("`agent/<issue-number>-<short-kebab-description>`");
  });
});

async function read(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

async function readBinary(path: string): Promise<Buffer> {
  return readFile(resolve(root, path));
}

async function readRelative(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function matches(input: string, pattern: RegExp): string[] {
  return [...input.matchAll(pattern)].map((match) => match[1]!).filter(Boolean);
}

function svgGeometry(input: string): { viewBox: string; paths: string[]; transforms: string[] } {
  return {
    viewBox: /viewBox="([^"]+)"/.exec(input)?.[1] ?? "",
    paths: matches(input, /<path\b[^>]*\bd="([^"]+)"/g),
    transforms: matches(input, /\btransform="([^"]+)"/g)
  };
}

function markdownAnchors(input: string): string[] {
  return matches(input, /^#{1,6}\s+(.+)$/gm).map((heading) => heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-"));
}
