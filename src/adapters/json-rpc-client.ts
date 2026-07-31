import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Logger } from "pino";

export interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  generation: number;
}

export class JsonRpcClient extends EventEmitter {
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
      this.rejectPending(new Error(`Codex app-server stdin failed: ${error.message}`), activeGeneration);
    });
    child.on("error", (error) => {
      this.rejectPending(new Error(`Codex app-server failed to start: ${error.message}`), activeGeneration);
      if (this.child === child) this.clearActiveTransport(activeGeneration);
      this.emit("close", { error }, activeGeneration);
    });
    child.on("exit", (code, signal) => {
      this.rejectPending(new Error(`Codex app-server exited before responding: code=${code ?? "unknown"} signal=${signal ?? "none"}`), activeGeneration);
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
        this.rejectPending(error, activeGeneration);
        reject(error);
      });
      socket.on("message", (data) => this.consume(data.toString(), activeGeneration));
      socket.on("close", (code, reason) => {
        this.rejectPending(new Error(`Codex app-server websocket closed: ${code} ${reason.toString()}`), activeGeneration);
        if (this.socket === socket) this.clearActiveTransport(activeGeneration);
        this.emit("close", { code, reason: reason.toString() }, activeGeneration);
      });
    });
    return activeGeneration;
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const generation = this.requireActiveGeneration();
    const id = this.nextId++;
    const message: JsonRpcMessage = { id, method };
    if (params !== undefined) message.params = params;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out after ${this.requestTimeoutMs}ms: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, generation });
      try {
        this.send(message, generation);
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
    this.send(message, generation);
  }

  respond(id: string | number, result: unknown, generation?: number): void {
    this.send({ id, result }, generation);
  }

  fail(id: string | number, code: number, message: string, generation?: number): void {
    this.send({ id, error: { code, message } }, generation);
  }

  close(): void {
    this.socket?.close();
    this.child?.kill();
    this.socket = undefined;
    this.child = undefined;
    this.activeGeneration = undefined;
  }

  private send(message: JsonRpcMessage, expectedGeneration?: number): void {
    const generation = this.requireActiveGeneration();
    if (expectedGeneration !== undefined && expectedGeneration !== generation) {
      throw new Error(`App-server connection changed (expected generation ${expectedGeneration}, current generation ${generation}).`);
    }
    const serialized = `${JSON.stringify(message)}\n`;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(serialized);
      return;
    }
    if (this.child) {
      if (this.child.killed || this.child.stdin.destroyed) throw new Error("JSON-RPC stdio transport is closed.");
      const ok = this.child.stdin.write(serialized);
      if (!ok) {
        this.child.stdin.once("drain", () => undefined);
      }
      return;
    }
    throw new Error("JSON-RPC client is not connected.");
  }

  private rejectPending(error: Error, generation?: number): void {
    for (const [id, pending] of this.pending.entries()) {
      if (generation !== undefined && pending.generation !== generation) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
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
      this.logger.warn({ raw, error }, "invalid JSON-RPC message");
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending || pending.generation !== generation) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }

    this.emit("message", message, generation);
  }

  private beginConnection(generation?: number): number {
    const next = generation ?? this.generation + 1;
    if (next <= this.generation) throw new Error(`App-server connection generation must increase (received ${next}, current ${this.generation}).`);
    this.generation = next;
    this.activeGeneration = next;
    this.buffer = "";
    return next;
  }

  private requireActiveGeneration(): number {
    if (this.activeGeneration === undefined) throw new Error("JSON-RPC client is not connected.");
    return this.activeGeneration;
  }

  private clearActiveTransport(generation: number): void {
    if (this.activeGeneration !== generation) return;
    this.child = undefined;
    this.socket = undefined;
    this.activeGeneration = undefined;
  }
}
