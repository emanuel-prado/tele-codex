import type { Context } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeHealth } from "../src/runtime/health.js";
import { reportTelegramFailure, withPromptCallbackAck } from "../src/telegram/error-boundary.js";

afterEach(() => vi.useRealTimers());

describe("Telegram error boundary", () => {
  it("returns the same safe correlation ID that it records in logs", async () => {
    const replies: string[] = [];
    const logs: unknown[] = [];
    const health = new RuntimeHealth();
    const logger = {
      error(fields: unknown) { logs.push(fields); },
      warn() {}
    } as never;
    const ctx = { reply: async (text: string) => { replies.push(text); } } as unknown as Pick<Context, "reply">;

    const correlationId = await reportTelegramFailure(ctx, new Error("private internal detail"), health, logger);

    expect(replies).toEqual([`tele-codex error (${correlationId}). Check the logs and retry.`]);
    expect(replies[0]).not.toContain("private internal detail");
    expect(logs[0]).toMatchObject({ correlationId, error: "private internal detail" });
  });

  it("acknowledges a slow callback before work completes and sends its final result afterward", async () => {
    vi.useFakeTimers();
    const acknowledgements: unknown[] = [];
    const replies: string[] = [];
    const work = deferred();
    const ctx = {
      callbackQuery: { id: "callback" },
      answerCallbackQuery: async (options?: unknown) => { acknowledgements.push(options); return true; },
      reply: async (text: string) => { replies.push(text); }
    } as unknown as Context;
    const running = withPromptCallbackAck(ctx, async () => {
      await work.promise;
      await ctx.answerCallbackQuery({ text: "Finished." });
    }, { debug() {} } as never, 100);

    await vi.advanceTimersByTimeAsync(100);
    expect(acknowledgements).toEqual([{ text: "Working..." }]);
    work.resolve();
    await running;
    expect(replies).toEqual(["Finished."]);
  });

  it("acknowledges a callback that fails before the slow-work timer", async () => {
    const acknowledgements: unknown[] = [];
    const ctx = {
      callbackQuery: { id: "callback" },
      answerCallbackQuery: async (options?: unknown) => { acknowledgements.push(options); return true; },
      reply: async () => undefined
    } as unknown as Context;

    await expect(withPromptCallbackAck(ctx, async () => {
      throw new Error("failed");
    }, { debug() {} } as never, 10_000)).rejects.toThrow("failed");
    expect(acknowledgements).toEqual([{ text: "Action failed. See the error message in chat.", show_alert: true }]);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
