import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Logger } from "pino";
import { appServerFailure, AppServerFailure, normalizeAppServerFailure } from "./app-server-failure.js";

export interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AppServerRpcClient {
  connectStdio(command: string, generation?: number): Promise<number>;
  connectWebSocket(url: string, token?: string, generation?: number): Promise<number>;
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown, generation?: number): void;
  respond(id: string | number, result: unknown, generation?: number): void;
  fail(id: string | number, code: number, message: string, generation?: number): void;
  close(): void;
  transportInfo(): { kind?: "stdio" | "websocket"; pid?: number };
  on(event: "activity", listener: (generation: number) => void): this;
  on(event: "message", listener: (message: JsonRpcMessage, generation: number) => void): this;
  on(event: "stderr", listener: (chunk: string, generation: number) => void): this;
  on(event: "close", listener: (details: unknown, generation: number) => void): this;
  on(event: "failure", listener: (failure: AppServerFailure, generation: number) => void): this;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  generation: number;
  method: string;
}

export class JsonRpcClient extends EventEmitter implements AppServerRpcClient {
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingRequest>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private socket: WebSocket | undefined;
  private buffer = "";
  private generation = 0;
  private activeGeneration: number | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly requestTimeoutMs = 30_000
  ) {
    super();
  }

  async connectStdio(command: string, generation?: number): Promise<number> {
    this.close();
    const activeGeneration = this.beginConnection(generation);
    const child = spawn(command, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk, activeGeneration));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.logger.debug({ chunk }, "codex app-server stderr");
      this.emit("stderr", chunk, activeGeneration);
    });
    child.stdin.on("error", (error) => {
      this.rejectPending(error, activeGeneration, "App-server transport was lost while writing a request.");
    });
    child.on("error", (error) => {
      this.rejectPending(error, activeGeneration, "App-server transport failed to start.");
      if (this.child === child) this.clearActiveTransport(activeGeneration);
      this.emit("close", { error }, activeGeneration);
    });
    child.on("exit", (code, signal) => {
      this.rejectPending({ code, signal }, activeGeneration, "App-server transport exited before responding.");
      if (this.child === child) this.clearActiveTransport(activeGeneration);
      this.emit("close", { code, signal }, activeGeneration);
    });
    return activeGeneration;
  }

  async connectWebSocket(url: string, token?: string, generation?: number): Promise<number> {
    this.close();
    const activeGeneration = this.beginConnection(generation);
    await new Promise<void>((resolve, reject) => {
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
      const socket = new WebSocket(url, { headers });
      this.socket = socket;
      socket.on("open", () => resolve());
      socket.on("error", (error) => {
        this.rejectPending(error, activeGeneration, "App-server WebSocket connection failed.");
        reject(error);
      });
      socket.on("message", (data) => this.consume(data.toString(), activeGeneration));
      socket.on("close", (code, reason) => {
        this.rejectPending({ code, reason: reason.toString() }, activeGeneration, "App-server WebSocket closed before responding.");
        if (this.socket === socket) this.clearActiveTransport(activeGeneration);
        this.emit("close", { code, reason: reason.toString() }, activeGeneration);
      });
    });
    return activeGeneration;
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const generation = this.requireActiveGeneration(method);
    const id = this.nextId++;
    const message: JsonRpcMessage = { id, method };
    if (params !== undefined) message.params = params;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(appServerFailure("timeout", `App-server request timed out after ${this.requestTimeoutMs}ms: ${method}.`, { method }));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, generation, method });
      try {
        this.send(message, generation, method);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params?: unknown, generation?: number): void {
    const message: JsonRpcMessage = { method };
    if (params !== undefined) message.params = params;
    this.send(message, generation, method);
  }

  respond(id: string | number, result: unknown, generation?: number): void {
    this.send({ id, result }, generation, "response");
  }

  fail(id: string | number, code: number, message: string, generation?: number): void {
    this.send({ id, error: { code, message } }, generation, "response");
  }

  close(): void {
    this.rejectPending(undefined, undefined, "App-server transport closed before responding.");
    this.socket?.close();
    this.child?.kill();
    this.socket = undefined;
    this.child = undefined;
    this.activeGeneration = undefined;
  }

  transportInfo(): { kind?: "stdio" | "websocket"; pid?: number } {
    if (this.child) return this.child.pid === undefined ? { kind: "stdio" } : { kind: "stdio", pid: this.child.pid };
    if (this.socket) return { kind: "websocket" };
    return {};
  }

  private send(message: JsonRpcMessage, expectedGeneration: number | undefined, method: string): void {
    const generation = this.requireActiveGeneration(method);
    if (expectedGeneration !== undefined && expectedGeneration !== generation) {
      throw appServerFailure(
        "generation_changed",
        `App-server connection changed before ${method} could be sent.`,
        { method }
      );
    }
    const serialized = `${JSON.stringify(message)}\n`;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(serialized);
      return;
    }
    if (this.child) {
      if (this.child.killed || this.child.stdin.destroyed) {
        throw appServerFailure("transport_loss", `App-server transport was lost before ${method} could be sent.`, { method });
      }
      const ok = this.child.stdin.write(serialized);
      if (!ok) {
        this.child.stdin.once("drain", () => undefined);
      }
      return;
    }
    throw appServerFailure("missing_connection", `App-server connection is not available for ${method}.`, { method });
  }

  private rejectPending(error: unknown, generation: number | undefined, message: string): void {
    for (const [id, pending] of this.pending.entries()) {
      if (generation !== undefined && pending.generation !== generation) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(normalizeAppServerFailure(error, "transport_loss", message, { method: pending.method }));
    }
  }

  private consume(chunk: string, generation: number): void {
    if (generation !== this.activeGeneration) return;
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const raw = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!raw) continue;
      this.handleRaw(raw, generation);
    }
  }

  private handleRaw(raw: string, generation: number): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch (error) {
      const failure = normalizeAppServerFailure(error, "protocol_defect", "App-server returned malformed JSON.");
      this.logger.warn({ error: failure.message }, "invalid JSON-RPC message");
      this.emit("failure", failure, generation);
      return;
    }
    this.emit("activity", generation);

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending || pending.generation !== generation) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(appServerFailure(
          "remote_rejection",
          `App-server rejected ${pending.method} (code ${message.error.code}).`,
          { method: pending.method, code: message.error.code, data: message.error.data }
        ));
      }
      else pending.resolve(message.result);
      return;
    }

    this.emit("message", message, generation);
  }

  private beginConnection(generation?: number): number {
    const next = generation ?? this.generation + 1;
    if (next <= this.generation) {
      throw appServerFailure("generation_changed", "App-server connection generation did not advance.", { method: "connect" });
    }
    this.generation = next;
    this.activeGeneration = next;
    this.buffer = "";
    return next;
  }

  private requireActiveGeneration(method: string): number {
    if (this.activeGeneration === undefined) {
      throw appServerFailure("missing_connection", `App-server connection is not available for ${method}.`, { method });
    }
    return this.activeGeneration;
  }

  private clearActiveTransport(generation: number): void {
    if (this.activeGeneration !== generation) return;
    this.child = undefined;
    this.socket = undefined;
    this.activeGeneration = undefined;
  }
}
