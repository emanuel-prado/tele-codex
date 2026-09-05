import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = join(root, "contracts/app-server/contract.json");
const sourcePath = join(root, "src/adapters/app-server-contract.ts");
const defaultResultDirectory = join(root, "codex-release-result");

export function selectNewestStableRelease(versions: readonly string[]): string | undefined {
  return versions
    .map(parseStableVersion)
    .filter((version): version is ParsedVersion => version !== undefined)
    .sort(compareParsedVersions)
    .at(-1)?.raw;
}

export type ReleaseClassification = "no-update" | "compatible" | "incompatible";

export function classifyRelease(
  checkedCodexVersion: string,
  candidateVersion: string,
  contractCompatible: boolean
): ReleaseClassification {
  const current = parseStableVersion(checkedCodexVersion.replace(/^codex-cli\s+/, ""));
  const candidate = parseStableVersion(candidateVersion);
  if (!current || !candidate) throw new Error("Codex release versions must be stable semantic versions");
  if (compareParsedVersions(candidate, current) <= 0) return "no-update";
  return contractCompatible ? "compatible" : "incompatible";
}

interface ParsedVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
}

function parseStableVersion(value: string): ParsedVersion | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return undefined;
  const components = match.slice(1).map(Number);
  if (!components.every(Number.isSafeInteger)) return undefined;
  return {
    raw: value,
    major: components[0]!,
    minor: components[1]!,
    patch: components[2]!
  };
}

function compareParsedVersions(left: ParsedVersion, right: ParsedVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

interface ReleaseResult {
  currentVersion: string;
  candidateVersion: string;
  classification: ReleaseClassification;
  runUrl: string;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function checkRelease(): Promise<void> {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { codexVersion?: unknown };
  if (typeof fixture.codexVersion !== "string") throw new Error("checked contract has no Codex version");

  const versionsResult = await run("npm", ["view", "@openai/codex", "versions", "--json"]);
  requireSuccess(versionsResult, "discover Codex CLI releases");
  const published = JSON.parse(versionsResult.stdout) as unknown;
  if (!Array.isArray(published) || !published.every((version) => typeof version === "string")) {
    throw new Error("npm returned an invalid Codex CLI version list");
  }
  const candidateVersion = selectNewestStableRelease(published);
  if (!candidateVersion) throw new Error("npm did not return a stable Codex CLI release");

  const resultDirectory = process.env.CODEX_RELEASE_OUTPUT_DIR || defaultResultDirectory;
  const runUrl = githubRunUrl();
  if (classifyRelease(fixture.codexVersion, candidateVersion, true) === "no-update") {
    await saveResult(resultDirectory, {
      currentVersion: fixture.codexVersion,
      candidateVersion,
      classification: "no-update",
      runUrl
    }, "The checked contract already targets the newest stable Codex CLI release.");
    return;
  }

  const installDirectory = await mkdtemp(join(tmpdir(), "tele-codex-release-check-"));
  try {
    const install = await run("npm", [
      "install",
      "--prefix", installDirectory,
      "--no-save",
      "--package-lock=false",
      "--ignore-scripts",
      `@openai/codex@${candidateVersion}`
    ]);
    requireSuccess(install, `install Codex CLI ${candidateVersion}`);
    const codexCommand = join(installDirectory, "node_modules", ".bin", "codex");
    const installedVersion = await run(codexCommand, ["--version"]);
    requireSuccess(installedVersion, "read installed Codex CLI version");
    if (extractCliVersion(installedVersion.stdout) !== candidateVersion) {
      throw new Error(`installed Codex CLI did not report exact version ${candidateVersion}`);
    }

    const contractCheck = await run(process.execPath, ["scripts/appserver-contract.mjs"], {
      ...process.env,
      TELE_CODEX_CODEX_COMMAND: codexCommand
    });
    const classification = classifyRelease(fixture.codexVersion, candidateVersion, contractCheck.code === 0);
    const details = commandDetails(contractCheck);
    if (classification === "compatible") {
      const refresh = await run(process.execPath, ["scripts/appserver-contract.mjs", "--refresh"], {
        ...process.env,
        TELE_CODEX_CODEX_COMMAND: codexCommand
      });
      requireSuccess(refresh, "refresh compatible app-server contract");
      await updateSourceVersion(fixture.codexVersion, `codex-cli ${candidateVersion}`);
    }
    await saveResult(resultDirectory, {
      currentVersion: fixture.codexVersion,
      candidateVersion,
      classification,
      runUrl
    }, details);
  } finally {
    await rm(installDirectory, { recursive: true, force: true });
  }
}

async function publishCompatible(): Promise<void> {
  const { result } = await loadResult();
  if (result.classification !== "compatible") throw new Error("release result is not compatible");
  const repository = githubRepository();
  const owner = repository.split("/")[0];
  if (!owner) throw new Error("GitHub repository owner is missing");
  const branch = `agent/57-codex-${result.candidateVersion.replaceAll(".", "-")}`;
  const title = `chore(codex): update checked CLI to ${result.candidateVersion}`;
  const body = [
    "Automated compatible Codex CLI contract refresh.",
    "",
    `- Checked version: \`${result.currentVersion}\``,
    `- Candidate version: \`codex-cli ${result.candidateVersion}\``,
    `- Verification run: ${result.runUrl}`,
    "",
    "Refs #57"
  ].join("\n");

  const listed = await run("gh", ["pr", "list", "--repo", repository, "--base", "develop", "--head", `${owner}:${branch}`, "--state", "all", "--limit", "20", "--json", "number,url"]);
  requireSuccess(listed, "find an existing Codex update pull request");
  const existing = JSON.parse(listed.stdout) as Array<{ number: number; url: string }>;
  if (existing.length > 0) {
    console.log(`Codex ${result.candidateVersion} pull request already exists: ${existing[0]?.url}`);
    return;
  }

  const remote = await run("git", ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`]);
  if (remote.code !== 0 && remote.code !== 2) requireSuccess(remote, "check the Codex update branch");
  if (remote.code === 2) {
    requireSuccess(await run("git", ["switch", "-c", branch]), "create the Codex update branch");
    requireSuccess(await run("git", ["config", "user.name", "github-actions[bot]"]), "configure git author name");
    requireSuccess(await run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]), "configure git author email");
    requireSuccess(await run("git", ["add", "--", "contracts/app-server/contract.json", "src/adapters/app-server-contract.ts"]), "stage the contract refresh");
    const changed = await run("git", ["diff", "--cached", "--quiet"]);
    if (changed.code === 0) throw new Error("compatible release produced no checked contract changes");
    if (changed.code !== 1) requireSuccess(changed, "inspect the staged contract refresh");
    requireSuccess(await run("git", ["commit", "-m", title]), "commit the contract refresh");
    requireSuccess(await run("git", ["push", "--set-upstream", "origin", branch]), "push the contract refresh");
  }
  const created = await run("gh", ["pr", "create", "--repo", repository, "--base", "develop", "--head", branch, "--draft", "--title", title, "--body", body]);
  requireSuccess(created, "create the draft Codex update pull request");
  console.log(created.stdout.trim());
}

async function publishIncompatible(): Promise<void> {
  const { result, report } = await loadResult();
  if (result.classification !== "incompatible") throw new Error("release result is not incompatible");
  const repository = githubRepository();
  const title = `Codex ${result.candidateVersion} app-server compatibility review`;
  const list = await run("gh", ["issue", "list", "--repo", repository, "--state", "all", "--limit", "100", "--search", `${title} in:title`, "--json", "number,title,body,comments,url"]);
  requireSuccess(list, "find an existing Codex compatibility issue");
  const issues = JSON.parse(list.stdout) as Array<{ number: number; title: string; body: string; comments: Array<{ body: string }>; url: string }>;
  const existing = issues.find((issue) => issue.title === title);
  const update = incompatibleIssueBody(result, report);
  if (!existing) {
    const created = await run("gh", ["issue", "create", "--repo", repository, "--title", title, "--label", "enhancement", "--label", "ready-for-human", "--body", update]);
    requireSuccess(created, "create the Codex compatibility issue");
    console.log(created.stdout.trim());
    return;
  }
  if (existing.body.includes(result.runUrl) || existing.comments.some((comment) => comment.body.includes(result.runUrl))) {
    console.log(`Compatibility issue already records this run: ${existing.url}`);
    return;
  }
  const commented = await run("gh", ["issue", "comment", String(existing.number), "--repo", repository, "--body", update]);
  requireSuccess(commented, "update the Codex compatibility issue");
  console.log(existing.url);
}

function incompatibleIssueBody(result: ReleaseResult, report: string): string {
  return [
    "The scheduled Codex release check found an incompatible app-server contract.",
    "",
    `- Checked version: \`${result.currentVersion}\``,
    `- Candidate version: \`codex-cli ${result.candidateVersion}\``,
    `- Failed check and downloadable report artifact: ${result.runUrl}`,
    "",
    "Review the differences below, adapt tele-codex if necessary, then manually rerun the workflow. The checked contract was not refreshed.",
    "",
    report
  ].join("\n");
}

async function saveResult(directory: string, result: ReleaseResult, details: string): Promise<void> {
  const report = [
    `# Codex CLI ${result.candidateVersion} contract check`,
    "",
    `- Checked version: \`${result.currentVersion}\``,
    `- Classification: **${result.classification}**`,
    `- Workflow run: ${result.runUrl || "local run"}`,
    "",
    "## Contract checker output",
    "",
    indent(details || "No contract differences reported.")
  ].join("\n");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(directory, "report.md"), `${report}\n`);
  const output = process.env.GITHUB_OUTPUT;
  if (output) await appendFile(output, `classification=${result.classification}\n`);
  console.log(`${result.classification}: Codex CLI ${result.candidateVersion} (checked ${result.currentVersion})`);
}

async function loadResult(): Promise<{ result: ReleaseResult; report: string }> {
  const directory = process.env.CODEX_RELEASE_OUTPUT_DIR || defaultResultDirectory;
  const value = JSON.parse(await readFile(join(directory, "result.json"), "utf8")) as Partial<ReleaseResult>;
  if (typeof value.currentVersion !== "string" || typeof value.candidateVersion !== "string" ||
      !parseStableVersion(value.candidateVersion) ||
      !["no-update", "compatible", "incompatible"].includes(value.classification ?? "") ||
      typeof value.runUrl !== "string") {
    throw new Error("invalid Codex release result artifact");
  }
  return { result: value as ReleaseResult, report: await readFile(join(directory, "report.md"), "utf8") };
}

async function updateSourceVersion(previous: string, next: string): Promise<void> {
  const source = await readFile(sourcePath, "utf8");
  const oldDeclaration = `APP_SERVER_CONTRACT_VERSION = ${JSON.stringify(previous)}`;
  const newDeclaration = `APP_SERVER_CONTRACT_VERSION = ${JSON.stringify(next)}`;
  if (!source.includes(oldDeclaration)) throw new Error("runtime checked-version declaration did not match the fixture");
  await writeFile(sourcePath, source.replace(oldDeclaration, newDeclaration));
}

function extractCliVersion(output: string): string | undefined {
  return /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/.exec(output)?.[1];
}

function githubRunUrl(): string {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  return repository && runId ? `https://github.com/${repository}/actions/runs/${runId}` : "";
}

function githubRepository(): string {
  const value = process.env.GITHUB_REPOSITORY ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error("GITHUB_REPOSITORY is invalid");
  return value;
}

function commandDetails(result: CommandResult): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").slice(0, 20_000);
}

function indent(value: string): string {
  return value.split(/\r?\n/).map((line) => `    ${line}`).join("\n");
}

function requireSuccess(result: CommandResult, operation: string): void {
  if (result.code !== 0) throw new Error(`Could not ${operation}:\n${commandDetails(result)}`);
}

function run(file: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], { cwd: root, env, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "check") await checkRelease();
  else if (command === "publish-compatible") await publishCompatible();
  else if (command === "publish-incompatible") await publishIncompatible();
  else throw new Error("usage: codex-release.ts <check|publish-compatible|publish-incompatible>");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
