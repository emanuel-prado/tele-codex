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
}

export class JsonRpcClient extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingRequest>();
  private child?: ChildProcessWithoutNullStreams;
  private socket?: WebSocket;
  private buffer = "";

  constructor(private readonly logger: Logger) {
    super();
  }

  async connectStdio(command: string): Promise<void> {
    this.child = spawn(command, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.logger.debug({ chunk }, "codex app-server stderr");
      this.emit("stderr", chunk);
    });
    this.child.stdin.on("error", (error) => {
      this.rejectPending(new Error(`Codex app-server stdin failed: ${error.message}`));
    });
    this.child.on("exit", (code, signal) => {
      this.rejectPending(new Error(`Codex app-server exited before responding: code=${code ?? "unknown"} signal=${signal ?? "none"}`));
      this.emit("close", { code, signal });
    });
  }

  async connectWebSocket(url: string, token?: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
      this.socket = new WebSocket(url, { headers });
      this.socket.on("open", () => resolve());
      this.socket.on("error", reject);
      this.socket.on("message", (data) => this.consume(data.toString()));
      this.socket.on("close", (code, reason) => this.emit("close", { code, reason: reason.toString() }));
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const message: JsonRpcMessage = { id, method };
    if (params !== undefined) message.params = params;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(message);
    });
  }

  notify(method: string, params?: unknown): void {
    const message: JsonRpcMessage = { method };
    if (params !== undefined) message.params = params;
    this.send(message);
  }

  respond(id: string | number, result: unknown): void {
    this.send({ id, result });
  }

  fail(id: string | number, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  close(): void {
    this.socket?.close();
    this.child?.kill();
  }

  private send(message: JsonRpcMessage): void {
    const serialized = `${JSON.stringify(message)}\n`;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(serialized);
      return;
    }
    if (this.child) {
      const ok = this.child.stdin.write(serialized);
      if (!ok) {
        this.child.stdin.once("drain", () => undefined);
      }
      return;
    }
    throw new Error("JSON-RPC client is not connected.");
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const raw = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!raw) continue;
      this.handleRaw(raw);
    }
  }

  private handleRaw(raw: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch (error) {
      this.logger.warn({ raw, error }, "invalid JSON-RPC message");
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }

    this.emit("message", message);
  }
}
