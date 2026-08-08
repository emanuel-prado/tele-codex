import { Bot } from "grammy";
import type { Logger } from "pino";
import type { RuntimeHealthReporter } from "../runtime/health.js";
import type { PolicyEngine } from "../security/policy.js";
import { reportTelegramFailure, withPromptCallbackAck } from "./error-boundary.js";

export interface TelegramCommandDefinition {
  command: string;
  description: string;
}

export interface TelegramRuntime {
  readonly bot: Bot;
  start(commands: TelegramCommandDefinition[]): Promise<void>;
  wait(): Promise<void>;
  stop(): void;
}

/** Owns Telegram transport setup; feature controllers never start a polling loop. */
export class TelegramBotRuntime implements TelegramRuntime {
  readonly bot: Bot;
  private pollingPromise?: Promise<void>;

  constructor(
    token: string,
    policy: PolicyEngine,
    health: RuntimeHealthReporter,
    logger: Logger
  ) {
    this.bot = new Bot(token);
    this.bot.use(async (ctx, next) => {
      if (!policy.authorizeTelegramUser(ctx.from?.id, ctx.chat?.id)) {
        logger.warn({ userId: ctx.from?.id, chatId: ctx.chat?.id }, "rejected unauthorized Telegram update");
        return;
      }
      health.telegramUpdate();
      await next();
    });
    this.bot.use((ctx, next) => withPromptCallbackAck(ctx, next, logger));
    this.bot.catch(async (error) => {
      await reportTelegramFailure(error.ctx, error.error, health, logger);
    });
  }

  async start(commands: TelegramCommandDefinition[]): Promise<void> {
    await this.bot.api.setMyCommands(commands);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    this.pollingPromise = this.bot.start({
      allowed_updates: ["message", "callback_query"],
      onStart: () => ready()
    });
    await Promise.race([
      started,
      this.pollingPromise.then(() => {
        throw new Error("Telegram polling exited during startup.");
      })
    ]);
  }

  wait(): Promise<void> {
    return this.pollingPromise ?? Promise.reject(new Error("Telegram polling was not started."));
  }

  stop(): void {
    if (this.bot.isRunning()) this.bot.stop();
  }
}
