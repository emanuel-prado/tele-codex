export interface TelegramIdCandidate {
  senderId: number;
  chatId: number;
  chatType: string;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface TelegramUpdate {
  message?: {
    from?: { id?: unknown };
    chat?: { id?: unknown; type?: unknown };
  };
}

export async function discoverTelegramIds(
  token: string | undefined,
  fetcher: FetchLike = fetch
): Promise<TelegramIdCandidate[]> {
  const botToken = token?.trim() ?? "";
  if (!botToken || botToken.includes("replace-with-")) {
    throw new Error("Set TELE_CODEX_BOT_TOKEN to your BotFather token, then try again.");
  }

  let response: Response;
  try {
    response = await fetcher(`https://api.telegram.org/bot${botToken}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 100, timeout: 0, allowed_updates: ["message"] })
    });
  } catch {
    throw new Error("Could not reach the Telegram Bot API. Check the network connection and try again.");
  }

  if (response.status === 401 || response.status === 404) {
    throw new Error("Telegram rejected the bot token. Copy a fresh token from BotFather and try again.");
  }
  if (response.status === 409) {
    throw new Error(
      "Telegram cannot read updates while another poller or webhook is active. Stop it, then try again."
    );
  }
  if (!response.ok) {
    throw new Error(`Telegram ID discovery failed with HTTP status ${response.status}. Try again later.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Telegram returned an unreadable response. Try again later.");
  }
  if (!isTelegramResult(payload)) {
    const code = apiErrorCode(payload);
    if (code === 401 || code === 404) {
      throw new Error("Telegram rejected the bot token. Copy a fresh token from BotFather and try again.");
    }
    if (code === 409) {
      throw new Error(
        "Telegram cannot read updates while another poller or webhook is active. Stop it, then try again."
      );
    }
    throw new Error("Telegram returned an unexpected response. Try again later.");
  }

  const seen = new Set<string>();
  const candidates: TelegramIdCandidate[] = [];
  for (const update of [...payload.result].reverse()) {
    if (!update || typeof update !== "object") continue;
    const senderId = update.message?.from?.id;
    const chatId = update.message?.chat?.id;
    const chatType = update.message?.chat?.type;
    if (!Number.isSafeInteger(senderId) || !Number.isSafeInteger(chatId) || typeof chatType !== "string") continue;
    const key = `${String(senderId)}:${String(chatId)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ senderId: senderId as number, chatId: chatId as number, chatType });
  }
  return candidates;
}

export function formatTelegramIds(candidates: TelegramIdCandidate[]): string {
  if (candidates.length === 0) {
    return "No recent Telegram messages found. Send your bot a message, then run this command again.";
  }
  return [
    "sender_id\tchat_id\tchat_type",
    ...candidates.map(({ senderId, chatId, chatType }) => `${senderId}\t${chatId}\t${chatType}`)
  ].join("\n");
}

function isTelegramResult(value: unknown): value is { ok: true; result: TelegramUpdate[] } {
  if (!value || typeof value !== "object") return false;
  const payload = value as { ok?: unknown; result?: unknown };
  return payload.ok === true && Array.isArray(payload.result);
}

function apiErrorCode(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const code = (value as { error_code?: unknown }).error_code;
  return typeof code === "number" ? code : undefined;
}
