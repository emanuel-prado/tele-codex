import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
});

async function read(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

async function readBinary(path: string): Promise<Buffer> {
  return readFile(resolve(root, path));
}

function matches(input: string, pattern: RegExp): string[] {
  return [...input.matchAll(pattern)].map((match) => match[1]!).filter(Boolean);
}
