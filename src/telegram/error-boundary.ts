import type { Context } from "grammy";
import type { Logger } from "pino";
import type { RuntimeHealthReporter } from "../runtime/health.js";

export async function reportTelegramFailure(
  ctx: Pick<Context, "reply">,
  error: unknown,
  health: RuntimeHealthReporter,
  logger: Logger
): Promise<string> {
  const failure = health.recordError("telegram-handler", error, false);
  logger.error({ correlationId: failure.correlationId, error: failure.message }, "Telegram command or callback failed");
  try {
    await ctx.reply(`tele-codex error (${failure.correlationId}). Check the logs and retry.`);
  } catch (replyError) {
    logger.warn({ correlationId: failure.correlationId, error: replyError }, "could not report Telegram command failure");
  }
  return failure.correlationId;
}

export async function withPromptCallbackAck(
  ctx: Context,
  next: () => Promise<void>,
  logger: Logger,
  delayMs = 750
): Promise<void> {
  if (!ctx.callbackQuery) {
    await next();
    return;
  }
  const original = ctx.answerCallbackQuery.bind(ctx);
  let answered = false;
  let automatic = false;
  ctx.answerCallbackQuery = (async (options?: Parameters<typeof original>[0]) => {
    if (!answered) {
      answered = true;
      return original(options);
    }
    if (automatic && typeof options === "object" && options && "text" in options && options.text) {
      await ctx.reply(String(options.text));
    }
    return true;
  }) as typeof ctx.answerCallbackQuery;
  const timer = setTimeout(() => {
    automatic = true;
    void ctx.answerCallbackQuery({ text: "Working..." }).catch((error) => {
      logger.debug({ error }, "could not acknowledge slow callback query");
    });
  }, delayMs);
  try {
    await next();
  } catch (error) {
    if (!answered) {
      try {
        await ctx.answerCallbackQuery({ text: "Action failed. See the error message in chat.", show_alert: true });
      } catch (ackError) {
        logger.debug({ error: ackError }, "could not acknowledge failed callback query");
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
