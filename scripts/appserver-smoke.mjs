#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const command = process.env.TELE_CODEX_CODEX_COMMAND || "codex";
const child = spawn(command, ["app-server", "--listen", "stdio://"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env
});
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");

let buffer = "";
let stderr = "";
let nextId = 1;
const pending = new Map();
let approvalResolve;
const approval = new Promise((resolve) => {
  approvalResolve = resolve;
});

child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const raw = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!raw) continue;
    const message = JSON.parse(raw);
    if (message.id !== undefined && message.method) {
      if (message.method === "item/commandExecution/requestApproval") {
        child.stdin.write(`${JSON.stringify({ id: message.id, result: { decision: "decline" } })}\n`);
        approvalResolve(message);
      } else {
        child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: `unsupported smoke request: ${message.method}` } })}\n`);
      }
      continue;
    }
    if (message.id === undefined || message.method) continue;
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  }
});
child.on("exit", (code, signal) => {
  const error = new Error(`app-server exited: code=${code ?? "unknown"} signal=${signal ?? "none"}\n${stderr}`);
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timed out: ${method}\n${stderr}`));
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`);
}

try {
  const initialized = await request("initialize", {
    clientInfo: { name: "tele-codex-smoke", title: "tele-codex smoke", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false }
  });
  notify("initialized");
  const [threads, search, limits, modes] = await Promise.all([
    request("thread/list", { limit: 1, sortKey: "updated_at", sortDirection: "desc", archived: false }),
    request("thread/search", { limit: 1, sortKey: "updated_at", sortDirection: "desc", archived: false, searchTerm: "tele-codex" }),
    request("account/rateLimits/read"),
    request("collaborationMode/list", {})
  ]);
  if (!initialized?.userAgent) throw new Error("initialize response has no userAgent");
  if (!Array.isArray(threads?.data)) throw new Error("thread/list response has no data array");
  if (!Array.isArray(search?.data)) throw new Error("thread/search response has no data array");
  if (!limits?.rateLimits?.primary || typeof limits.rateLimits.primary.usedPercent !== "number") {
    throw new Error("account/rateLimits/read response has no primary usage");
  }
  if (!Array.isArray(modes?.data)) throw new Error("collaborationMode/list response has no data array");
  if (process.env.TELE_CODEX_APPSERVER_APPROVAL_SMOKE === "1") {
    const workspace = await mkdtemp(join(tmpdir(), "tele-codex-approval-smoke-"));
    let threadId;
    try {
      const started = await request("thread/start", {
        cwd: workspace,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        model: null
      });
      threadId = started?.thread?.id;
      if (!threadId) throw new Error("approval smoke thread/start response has no thread id");
      await request("turn/start", {
        threadId,
        input: [{ type: "text", text: "Run exactly `printf tele-codex-approval-smoke` once, then stop.", text_elements: [] }]
      });
      await Promise.race([
        approval,
        new Promise((_, reject) => setTimeout(() => reject(new Error("approval smoke did not receive a command approval")), 60_000))
      ]);
      console.log("app-server live approval ok: request received and declined");
    } finally {
      if (threadId) await request("thread/archive", { threadId }).catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  } else {
    console.log("app-server live approval skipped (set TELE_CODEX_APPSERVER_APPROVAL_SMOKE=1 to enable)");
  }
  console.log(`app-server contract ok: ${initialized.userAgent}`);
} finally {
  child.stdin.end();
  child.kill("SIGINT");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_000))
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
