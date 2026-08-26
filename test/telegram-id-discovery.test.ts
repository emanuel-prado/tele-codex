import { describe, expect, it, vi } from "vitest";
import { discoverTelegramIds, formatTelegramIds } from "../src/runtime/telegram-id-discovery.js";

describe("Telegram ID discovery", () => {
  it("requires only a configured bot token", async () => {
    const fetcher = vi.fn();

    await expect(discoverTelegramIds(undefined, fetcher)).rejects.toThrow(
      "Set TELE_CODEX_BOT_TOKEN to your BotFather token, then try again."
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns the newest unique sender and chat pairs without message data", async () => {
    let request: RequestInit | undefined;
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      request = init;
      return jsonResponse({
        ok: true,
        result: [
          update(1, 100, 100, "private", "old private text"),
          update(2, 100, -200, "supergroup", "group text"),
          update(3, 100, 100, "private", "new private text")
        ]
      });
    });

    const result = await discoverTelegramIds("secret-token", fetcher);

    expect(result).toEqual([
      { senderId: 100, chatId: 100, chatType: "private" },
      { senderId: 100, chatId: -200, chatType: "supergroup" }
    ]);
    expect(formatTelegramIds(result)).toBe(
      "sender_id\tchat_id\tchat_type\n100\t100\tprivate\n100\t-200\tsupergroup"
    );
    expect(formatTelegramIds(result)).not.toContain("text");
    expect(JSON.parse(String(request?.body))).toEqual({
      limit: 100,
      timeout: 0,
      allowed_updates: ["message"]
    });
  });

  it("explains how to create an update when none are available", async () => {
    const result = await discoverTelegramIds("secret-token", async () => jsonResponse({ ok: true, result: [] }));

    expect(formatTelegramIds(result)).toContain("Send your bot a message");
  });

  it("rejects malformed Telegram responses", async () => {
    await expect(
      discoverTelegramIds("secret-token", async () => jsonResponse({ ok: true, result: "not-an-array" }))
    ).rejects.toThrow("Telegram returned an unexpected response. Try again later.");
  });

  it.each([
    [401, "Telegram rejected the bot token"],
    [404, "Telegram rejected the bot token"],
    [409, "another poller or webhook is active"],
    [500, "HTTP status 500"]
  ])("turns HTTP %s into safe guidance", async (status, expected) => {
    const token = "123456:private-bot-token";
    await expect(
      discoverTelegramIds(token, async () => new Response("private upstream detail", { status }))
    ).rejects.toThrow(expected);

    try {
      await discoverTelegramIds(token, async () => new Response("private upstream detail", { status }));
    } catch (error) {
      expect(String(error)).not.toContain(token);
      expect(String(error)).not.toContain("private upstream detail");
    }
  });

  it("does not expose network failure details", async () => {
    const token = "123456:private-bot-token";
    await expect(
      discoverTelegramIds(token, async () => Promise.reject(new Error(`request failed for ${token}`)))
    ).rejects.toThrow("Could not reach the Telegram Bot API");
  });
});

function update(updateId: number, senderId: number, chatId: number, chatType: string, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: updateId,
      from: { id: senderId, first_name: "Private name", username: "private_username" },
      chat: { id: chatId, type: chatType, title: "Private title" },
      text
    }
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
