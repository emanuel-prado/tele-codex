#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);
const fixtureUrl = new URL("contracts/app-server/contract.json", root);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
const sourceVersion = /APP_SERVER_CONTRACT_VERSION\s*=\s*"([^"]+)"/.exec(
  await readFile(new URL("src/adapters/app-server-contract.ts", root), "utf8")
)?.[1];
const command = process.env.TELE_CODEX_CODEX_COMMAND || "codex";
const refresh = process.argv.includes("--refresh");
const fixtureOnly = process.argv.includes("--fixture-only");
validateRuntimeFixture(await readFile(new URL("src/adapters/app-server-adapter.ts", root), "utf8"));
if (sourceVersion !== fixture.codexVersion) {
  throw new Error(`runtime contract version ${sourceVersion ?? "missing"} differs from fixture ${fixture.codexVersion}`);
}
if (fixtureOnly) {
  console.log(`app-server fixture ok: ${fixture.codexVersion}`);
  process.exit(0);
}
const directory = await mkdtemp(join(tmpdir(), "tele-codex-appserver-contract-"));

try {
  const tsDirectory = join(directory, "ts");
  const jsonDirectory = join(directory, "json");
  await execFileAsync(command, ["app-server", "generate-ts", "--experimental", "--out", tsDirectory], { timeout: 30_000 });
  await execFileAsync(command, ["app-server", "generate-json-schema", "--experimental", "--out", jsonDirectory], { timeout: 30_000 });
  const version = firstLine((await execFileAsync(command, ["--version"], { timeout: 10_000 })).stdout);
  const clientMethods = await schemaMethods(join(jsonDirectory, "ClientRequest.json"));
  const serverMethods = await schemaMethods(join(jsonDirectory, "ServerRequest.json"));
  const notifications = await schemaMethods(join(jsonDirectory, "ServerNotification.json"));
  const requiredFields = {};
  for (const path of Object.keys(fixture.requiredFields)) {
    const schema = JSON.parse(await readFile(join(jsonDirectory, path), "utf8"));
    requiredFields[path] = [...(schema.required ?? [])].sort();
  }
  const generated = {
    codexVersion: version,
    generatedAt: new Date().toISOString().slice(0, 10),
    clientMethods: fixture.clientMethods,
    serverMethods: fixture.serverMethods,
    notifications: fixture.notifications,
    requiredFields
  };
  if (refresh) {
    await writeFile(fixtureUrl, `${JSON.stringify(generated, null, 2)}\n`);
    if (version !== sourceVersion) {
      console.warn(`update APP_SERVER_CONTRACT_VERSION to ${JSON.stringify(version)} after reviewing this refresh`);
    }
    console.log(`refreshed app-server contract for ${version}`);
  } else {
    const missing = [
      ...missingValues("client method", fixture.clientMethods, clientMethods),
      ...missingValues("server method", fixture.serverMethods, serverMethods),
      ...missingValues("notification", fixture.notifications, notifications)
    ];
    const changedShapes = Object.entries(requiredFields).flatMap(([path, fields]) =>
      JSON.stringify(fields) === JSON.stringify(fixture.requiredFields[path])
        ? []
        : [`shape ${path}: expected [${fixture.requiredFields[path].join(", ")}], received [${fields.join(", ")}]`]
    );
    if (missing.length > 0 || changedShapes.length > 0) {
      const details = [...missing, ...changedShapes].map((line) => `  ${line}`).join("\n");
      throw new Error(`installed app-server contract differs from ${fixture.codexVersion}:\n${details}\nRun npm run contract:refresh and review the protocol changes.`);
    }
    console.log(`app-server contract ok: installed ${version}; fixture ${fixture.codexVersion}`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

function firstLine(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "unknown";
}

async function schemaMethods(path) {
  const schema = JSON.parse(await readFile(path, "utf8"));
  return (schema.oneOf ?? []).flatMap((entry) => entry.properties?.method?.enum ?? []).sort();
}

function missingValues(kind, expected, actual) {
  const available = new Set(actual);
  return expected.filter((value) => !available.has(value)).map((value) => `missing ${kind}: ${value}`);
}

function validateRuntimeFixture(source) {
  const clientMethods = matches(source, /rpc\.request\("([^"]+)"/g);
  const supportedBlock = /function isSupportedInteractiveRequest[\s\S]*?\n}/.exec(source)?.[0] ?? "";
  const serverMethods = matches(supportedBlock, /"([^"]+)"/g);
  const notifications = matches(source, /message\.method === "([^"]+)"/g);
  for (const [name, expected, actual] of [
    ["client methods", fixture.clientMethods, clientMethods],
    ["server methods", fixture.serverMethods, serverMethods],
    ["notifications", fixture.notifications, notifications]
  ]) {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error(`runtime ${name} differ from the checked fixture:\n  fixture: ${expected.join(", ")}\n  runtime: ${actual.join(", ")}`);
    }
  }
}

function matches(source, pattern) {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1]))].sort();
}
