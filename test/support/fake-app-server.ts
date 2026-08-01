import { EventEmitter } from "node:events";
import type { AppServerRpcClient, JsonRpcMessage } from "../../src/adapters/json-rpc-client.js";

interface TraceEntry {
  sequence: number;
  generation: number;
  direction: "connect" | "client" | "server" | "close";
  message: JsonRpcMessage | { transport: string };
}

type RequestHandler = (params: unknown, generation: number) => unknown | Promise<unknown>;

export class FakeAppServer extends EventEmitter implements AppServerRpcClient {
  private generation = 0;
  private sequence = 0;
  private activeGeneration: number | undefined;
  private readonly handlers = new Map<string, RequestHandler>();
  readonly trace: TraceEntry[] = [];

  constructor() {
    super();
    this.respondTo("initialize", () => ({ userAgent: "fake-codex/contract" }));
  }

  respondTo(method: string, handler: RequestHandler | unknown): void {
    this.handlers.set(method, typeof handler === "function" ? handler as RequestHandler : () => handler);
  }

  async connectStdio(_command: string, generation?: number): Promise<number> {
    return this.connect("stdio", generation);
  }

  async connectWebSocket(_url: string, _token?: string, generation?: number): Promise<number> {
    return this.connect("websocket", generation);
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const generation = this.requireGeneration();
    this.record("client", generation, { method, params });
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`Fake app-server has no response for ${method}.\n${this.formatTrace()}`);
    return handler(params, generation);
  }

  notify(method: string, params?: unknown, generation = this.requireGeneration()): void {
    this.assertGeneration(generation);
    this.record("client", generation, { method, params });
  }

  respond(id: string | number, result: unknown, generation = this.requireGeneration()): void {
    this.assertGeneration(generation);
    this.record("client", generation, { id, result });
  }

  fail(id: string | number, code: number, message: string, generation = this.requireGeneration()): void {
    this.assertGeneration(generation);
    this.record("client", generation, { id, error: { code, message } });
  }

  serverRequest(id: string | number, method: string, params: unknown, generation = this.requireGeneration()): void {
    this.serverMessage({ id, method, params }, generation);
  }

  notification(method: string, params?: unknown, generation = this.requireGeneration()): void {
    this.serverMessage({ method, params }, generation);
  }

  malformed(message: JsonRpcMessage, generation = this.requireGeneration()): void {
    this.serverMessage(message, generation);
  }

  disconnect(generation = this.requireGeneration()): void {
    this.record("close", generation, { transport: "disconnected" });
    if (generation === this.activeGeneration) this.activeGeneration = undefined;
    this.emit("close", { reason: "fake disconnect" }, generation);
  }

  close(): void {
    this.activeGeneration = undefined;
  }

  transportInfo(): { kind: "stdio"; pid: number } {
    return { kind: "stdio", pid: 4242 };
  }

  messages(method: string): TraceEntry[] {
    return this.trace.filter((entry) => "method" in entry.message && entry.message.method === method);
  }

  formatTrace(): string {
    return this.trace.map((entry) => {
      const payload = "method" in entry.message
        ? entry.message.method ?? (entry.message.id === undefined ? "malformed" : `response:${entry.message.id}`)
        : JSON.stringify(entry.message);
      return `${entry.sequence}. g${entry.generation} ${entry.direction} ${payload}`;
    }).join("\n");
  }

  private connect(transport: string, generation?: number): number {
    const next = generation ?? this.generation + 1;
    if (next <= this.generation) throw new Error(`generation must increase: ${next} <= ${this.generation}`);
    this.generation = next;
    this.activeGeneration = next;
    this.record("connect", next, { transport });
    return next;
  }

  private serverMessage(message: JsonRpcMessage, generation: number): void {
    this.record("server", generation, message);
    this.emit("activity", generation);
    this.emit("message", message, generation);
  }

  private record(direction: TraceEntry["direction"], generation: number, message: TraceEntry["message"]): void {
    this.trace.push({ sequence: ++this.sequence, generation, direction, message });
  }

  private requireGeneration(): number {
    if (this.activeGeneration === undefined) throw new Error(`Fake app-server is disconnected.\n${this.formatTrace()}`);
    return this.activeGeneration;
  }

  private assertGeneration(generation: number): void {
    const active = this.requireGeneration();
    if (generation !== active) throw new Error(`stale generation ${generation}; active ${active}.\n${this.formatTrace()}`);
  }
}
