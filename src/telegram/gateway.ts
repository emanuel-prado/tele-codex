import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import { PolicyEngine } from "../security/policy.js";
import { Store } from "../store/store.js";
import type { StoredSession } from "../store/store.js";
import type { CodexEvent, ApprovalDecision, SessionRef } from "../types/events.js";
import type {
  CodexModelSummary,
  CodexThreadSummary,
  CollaborationModeKind,
  RateLimitSummary,
  SessionProgress,
  ThreadGoalSummary
} from "../types/control.js";
import { SessionManager } from "../runtime/session-manager.js";
import { listWorkspaceProjects, resolveWorkspacePath, type WorkspaceProject } from "../runtime/workspace.js";
import {
  appendAgentMessageChunk,
  escapeMd,
  formatAction,
  formatAgentMessage,
  formatLogs,
  formatSessions,
  formatStatus,
  formatThreads,
  formatUsage,
  truncateMiddle
} from "./format.js";
import { LegacyTmuxBridge, type ProbeResult } from "../legacy/legacy-tmux-bridge.js";
import type { LegacyTmuxAttachment } from "../types/legacy-tmux.js";
import { formatDoctorReport, runDoctor } from "../runtime/doctor.js";
import { parseResumeCommand } from "./resume-command.js";
import { PendingInteractionManager, type InteractionView } from "./pending-interaction.js";
import { createId, createNonce } from "../utils/ids.js";
import { TelegramRouting } from "./routing.js";

export class TelegramGateway {
  private readonly bot: Bot;
  private readonly runtimeId = createId("runtime");
  private readonly messageBuffers = new Map<string, { text: string; timer: NodeJS.Timeout }>();
  private readonly projectSelections = new Map<string, WorkspaceProject>();
  private readonly threadSelections = new Map<string, CodexThreadSummary>();
  private readonly modelSelections = new Map<string, CodexModelSummary>();
  private readonly processSelections = new Map<string, { sessionId: string; processId: string; command: string }>();
  private readonly interactions: PendingInteractionManager;
  private readonly routing: TelegramRouting;
  private outboxTimer: NodeJS.Timeout | undefined;
  private actionSweepTimer: NodeJS.Timeout | undefined;
  private drainingOutbox = false;

  constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionManager,
    private readonly legacyTmux: LegacyTmuxBridge,
    private readonly store: Store,
    private readonly policy: PolicyEngine,
    private readonly logger: Logger
  ) {
    this.bot = new Bot(config.botToken);
    this.interactions = new PendingInteractionManager(store, config.allowSessionGrants);
    this.routing = new TelegramRouting(store, sessions);
    this.bot.use(async (ctx, next) => {
      if (!this.policy.authorizeTelegramUser(ctx.from?.id, ctx.chat?.id)) {
        this.logger.warn({ userId: ctx.from?.id, chatId: ctx.chat?.id }, "rejected unauthorized Telegram update");
        return;
      }
      await next();
    });
    this.bot.catch(async (error) => {
      this.logger.error({ error }, "Telegram bot middleware failed");
      const detail = error.error instanceof Error ? error.error.message : "Telegram command failed.";
      try {
        await error.ctx.reply(`tele-codex error: ${detail}`);
      } catch (replyError) {
        this.logger.warn({ replyError }, "could not report Telegram command failure");
      }
    });
    this.registerHandlers();
  }

  async start(): Promise<void> {
    void this.forwardCodexEvents();
    this.outboxTimer = setInterval(() => void this.drainOutbox(), 1_000);
    this.actionSweepTimer = setInterval(() => {
      void this.sessions.expirePendingActions().catch((error) => this.logger.error({ error }, "pending action sweep failed"));
    }, 1_000);
    void this.drainOutbox();
    await this.bot.api.setMyCommands([
      { command: "status", description: "Show active Codex session" },
      { command: "panel", description: "Show session control panel" },
      { command: "sessions", description: "List local sessions" },
      { command: "new", description: "Start a new Codex session" },
      { command: "resume", description: "Resume a previous Codex session" },
      { command: "threads", description: "List previous Codex sessions" },
      { command: "model", description: "Change active session model" },
      { command: "models", description: "List available models" },
      { command: "plan", description: "Switch active session to plan mode" },
      { command: "mode", description: "Switch collaboration mode" },
      { command: "compact", description: "Start context compaction" },
      { command: "archive", description: "Archive active app-server thread" },
      { command: "detach", description: "Detach active app-server thread" },
      { command: "forget", description: "Forget local thread metadata" },
      { command: "send", description: "Send one message to a selected thread" },
      { command: "use", description: "Opt into sticky routing for this chat" },
      { command: "attach", description: "Attach an app-server thread" },
      { command: "tmux", description: "Use explicit legacy tmux fallback" },
      { command: "log", description: "Show recent session log" },
      { command: "usage", description: "Show active session token usage" },
      { command: "pending", description: "Show pending Codex interactions" },
      { command: "health", description: "Show unattended-operation health" },
      { command: "retrydelivery", description: "Retry failed notifications" },
      { command: "search", description: "Search previous Codex sessions" },
      { command: "limits", description: "Show Codex account limits" },
      { command: "progress", description: "Show the active turn plan" },
      { command: "diff", description: "Export the latest turn diff" },
      { command: "goal", description: "Control the active thread goal" },
      { command: "processes", description: "Show background processes" },
      { command: "doctor", description: "Run local health checks" },
      { command: "transcript", description: "Export active session transcript" },
      { command: "approve", description: "Approve a pending request by id" },
      { command: "deny", description: "Deny a pending request by id" },
      { command: "pause", description: "Pause Telegram input forwarding" },
      { command: "unpause", description: "Resume Telegram input forwarding" },
      { command: "kill", description: "Interrupt active turn" },
      { command: "help", description: "Show help" }
    ]);
    await this.sendStartupPicker();
    await this.bot.start({
      allowed_updates: ["message", "callback_query"]
    });
  }

  async stop(): Promise<void> {
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    if (this.actionSweepTimer) clearInterval(this.actionSweepTimer);
    this.outboxTimer = undefined;
    this.actionSweepTimer = undefined;
    for (const buffer of this.messageBuffers.values()) clearTimeout(buffer.timer);
    for (const sessionId of [...this.messageBuffers.keys()]) await this.flushAgentMessage(sessionId);
    await this.drainOutbox();
    this.bot.stop();
  }

  private registerHandlers(): void {
    this.bot.command("help", async (ctx) => {
      await ctx.reply(
        [
          "/status - active session",
          "/panel - session control panel",
          "/sessions - list current and recoverable threads; /sessions all includes diagnostics",
          "/new - pick a workspace project",
          "/new <project-or-path> - start app-server session in a workspace folder",
          "/resume - list previous Codex sessions",
          "/resume last - resume the most recent Codex session",
          "/resume <threadId|localSessionId> - resume a previous session",
          "/threads - list previous Codex sessions",
          "/model - list models; /model <id> changes active session model",
          "/plan [on|off] - switch active app-server session mode",
          "/mode <plan|default> - switch active app-server session mode",
          "/compact - start Codex context compaction for the active thread",
          "/archive - archive the active app-server thread",
          "/detach - remove the active live attachment without deleting its thread",
          "/forget <sessionId> - remove local tele-codex metadata after confirmation",
          "/send - choose a thread for your next message",
          "/send <thread-alias-or-id> <message> - send directly to one thread",
          "/use <thread-alias-or-id> - opt into sticky routing; /use off disables it",
          "/attach appserver <threadId> - attach Codex thread",
          "/tmux - list panes for the legacy fallback",
          "/tmux attach <target> - attach a legacy tmux pane",
          "/tmux send <attachmentId> <text> - send through the legacy fallback",
          "/tmux test <attachmentId> - test legacy tmux input",
          "/tmux interrupt <attachmentId> - send Ctrl-C through tmux",
          "/log [n] - recent logs",
          "/usage - current token usage",
          "/pending - pending questions and approvals",
          "/health - app-server and delivery health",
          "/retrydelivery - retry failed high-signal notifications",
          "/search <term> - search previous Codex sessions",
          "/limits - account rate limits",
          "/progress - active turn plan",
          "/diff - latest turn diff",
          "/goal [start <objective>|pause|resume|clear] - durable goal controls",
          "/processes - background terminals",
          "/doctor - local setup health checks",
          "/transcript - export full active transcript",
          "/pause and /unpause - toggle forwarding",
          "/kill - interrupt active session",
          "Plain text needs /send, a reply to agent output, or an explicit /use route."
        ].join("\n")
      );
    });

    this.bot.command("status", async (ctx) => {
      const active = this.sessions.getActiveSession();
      await ctx.reply(active ? this.statusText(active) : "No active Codex session.");
    });

    this.bot.command("panel", async (ctx) => {
      await this.showPanel(ctx);
    });

    this.bot.command("sessions", async (ctx) => {
      const includeAll = String(ctx.match ?? "").trim().toLowerCase() === "all";
      const sessions = this.sessions.listSessions(includeAll);
      await ctx.reply(formatSessions(sessions), { reply_markup: sessionsKeyboard(sessions) });
    });

    this.bot.command("new", async (ctx) => {
      const rest = parseAppServerCommand(ctx.match);
      if (!rest) {
        await this.showWorkspacePicker(ctx);
        return;
      }
      const project = resolveWorkspacePath(this.config.workspaceRoot, rest || String(ctx.match ?? "").trim());
      await this.ensureDirectory(project.path);
      await this.startProjectSession(ctx, project);
    });

    this.bot.command("threads", async (ctx) => {
      await this.showThreadPicker(ctx);
    });

    this.bot.command("resume", async (ctx) => {
      const command = parseResumeCommand(ctx.match);
      if (command.kind === "picker") {
        await this.showThreadPicker(ctx);
        return;
      }
      try {
        const session =
          command.kind === "last"
            ? await this.sessions.resumeLatestThread()
            : await this.resumeTarget(command.target);
        await ctx.reply(`Resumed Codex session:\n${session.label}\n${session.id}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to resume the Codex session.";
        await ctx.reply(message);
      }
    });

    this.bot.command("models", async (ctx) => {
      await this.showModelPicker(ctx);
    });

    this.bot.command("model", async (ctx) => {
      const model = String(ctx.match ?? "").trim();
      if (!model) {
        await this.showModelPicker(ctx);
        return;
      }
      await this.sessions.setModel(model);
      await ctx.reply(`Model changed for subsequent turns:\n${model}`);
    });

    this.bot.command("plan", async (ctx) => {
      const raw = String(ctx.match ?? "").trim().toLowerCase();
      const mode: CollaborationModeKind = raw === "off" || raw === "default" ? "default" : "plan";
      await this.sessions.setMode(mode);
      await ctx.reply(mode === "plan" ? "Plan mode enabled for subsequent turns." : "Default mode enabled for subsequent turns.");
    });

    this.bot.command("mode", async (ctx) => {
      const mode = String(ctx.match ?? "").trim().toLowerCase();
      if (mode !== "plan" && mode !== "default") {
        await ctx.reply("Usage: /mode <plan|default>");
        return;
      }
      await this.sessions.setMode(mode);
      await ctx.reply(`Mode changed for subsequent turns:\n${mode}`);
    });

    this.bot.command("compact", async (ctx) => {
      await this.sessions.compact();
      await ctx.reply("Started context compaction for the active thread.");
    });

    this.bot.command("archive", async (ctx) => {
      const active = this.sessions.getActiveSession();
      if (!active) {
        await ctx.reply("No active session.");
        return;
      }
      const keyboard = new InlineKeyboard().text("Confirm archive", `archive:${active.id}:confirm`);
      await ctx.reply(`Archive active app-server thread?\n${active.id}`, { reply_markup: keyboard });
    });

    this.bot.command("detach", async (ctx) => {
      const active = this.sessions.getActiveSession();
      if (!active) {
        await ctx.reply("No active attached session.");
        return;
      }
      await this.sessions.detach(active.id);
      await ctx.reply(`Detached thread:\n${active.id}\nUse /sessions to resume it.`);
    });

    this.bot.command("forget", async (ctx) => {
      const requestedId = String(ctx.match ?? "").trim();
      const sessionId = requestedId || this.sessions.getActiveSession()?.id;
      if (!sessionId || !this.store.getSession(sessionId)) {
        await ctx.reply("Usage: /forget <sessionId>. Use /sessions all to find diagnostic records.");
        return;
      }
      const keyboard = new InlineKeyboard().text("Confirm forget", `forget:${sessionId}:confirm`);
      await ctx.reply(`Forget local tele-codex metadata for this thread? Codex history is not deleted.\n${sessionId}`, { reply_markup: keyboard });
    });

    this.bot.command("send", async (ctx) => {
      const input = String(ctx.match ?? "").trim();
      if (!input) {
        await this.showSendPicker(ctx);
        return;
      }
      const direct = input.match(/^(\S+)\s+([\s\S]+)$/);
      if (!direct) {
        await ctx.reply("Usage: /send <thread-alias-or-id> <message>, or run /send to choose a thread.");
        return;
      }
      const routed = await this.routing.sendDirect(ctx.chat.id, ctx.from!.id, direct[1]!, direct[2]!);
      await ctx.reply(`Sent to ${routed.session.label}.`);
    });

    this.bot.command("use", async (ctx) => {
      const target = String(ctx.match ?? "").trim();
      if (!target) {
        await ctx.reply("Usage: /use <thread-alias-or-id>, or /use off to disable sticky routing.");
        return;
      }
      if (["off", "none", "clear"].includes(target.toLowerCase())) {
        this.routing.clearSticky(ctx.chat.id, ctx.from!.id);
        await ctx.reply("Sticky routing disabled. Plain text now requires /send or a reply to agent output.");
        return;
      }
      const session = await this.routing.setSticky(ctx.chat.id, ctx.from!.id, target);
      await ctx.reply(`Sticky routing enabled for this chat and user:\n${session.label}\n${session.id}`);
    });

    this.bot.command("attach", async (ctx) => {
      const parts = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
      const kind = parts[0];
      const target = parts[1];
      if (!kind) {
        await ctx.reply("Usage: /attach appserver <threadId>. Use /resume to pick previous threads, or /tmux for the separate legacy fallback.");
        return;
      }
      if (kind === "appserver" && target) {
        const session = await this.sessions.attach({ codexThreadId: target });
        await ctx.reply(`Attached app-server thread:\n${session.id}`);
        return;
      }
      await ctx.reply("Usage: /attach appserver <threadId>. Legacy tmux is available only through /tmux.");
    });

    this.bot.command("tmux", async (ctx) => {
      const input = String(ctx.match ?? "").trim();
      if (!input) {
        await this.showAttachPicker(ctx);
        return;
      }
      const [action, target, ...rest] = input.split(/\s+/);
      if (action === "list") {
        await ctx.reply(formatLegacyAttachments(this.legacyTmux.listAttachments(ctx.chat.id)));
        return;
      }
      if (action === "send" && target && rest.length > 0) {
        const preview = await this.legacyTmux.send(target, ctx.chat.id, rest.join(" "));
        await ctx.reply(`Legacy tmux fallback sent text. Verify the pane locally.\n\n${preview.slice(-800)}`);
        return;
      }
      if (action === "test" && target) {
        await this.sendProbeResult(ctx.chat.id, ctx.from!.id, await this.legacyTmux.probe(target, ctx.chat.id));
        return;
      }
      if (action === "interrupt" && target) {
        await this.legacyTmux.interrupt(target, ctx.chat.id);
        await ctx.reply("Sent Ctrl-C through the legacy tmux fallback.");
        return;
      }
      const paneTarget = action === "attach" ? target : input;
      if (!paneTarget) {
        await ctx.reply("Usage: /tmux attach <target> | send <attachmentId> <text> | test <attachmentId> | interrupt <attachmentId>");
        return;
      }
      const attachment = await this.legacyTmux.attach(paneTarget, ctx.chat.id);
      await ctx.reply(`Attached legacy tmux fallback pane:\n${attachment.id}\n\nSending input test...`);
      await this.sendProbeResult(ctx.chat.id, ctx.from!.id, await this.legacyTmux.probe(attachment.id, ctx.chat.id));
    });

    this.bot.command("log", async (ctx) => {
      const limit = Number(String(ctx.match ?? "").trim()) || 30;
      const logs = await this.sessions.logs(undefined, Math.min(limit, 100));
      await ctx.reply(formatLogs(logs));
    });

    this.bot.command("usage", async (ctx) => {
      const active = this.sessions.getActiveSession();
      if (!active) {
        await ctx.reply("No active session.");
        return;
      }
      await ctx.reply(formatUsage(this.store.getTokenUsage(active.id)));
    });

    this.bot.command("pending", async (ctx) => {
      const actions = this.store.listPendingActions();
      if (actions.length === 0) {
        await ctx.reply("No pending Codex interactions.");
        return;
      }
      for (const action of actions) {
        const view = this.interactions.actionView(action, ctx.chat.id);
        await ctx.reply(`${formatAction(action)}\n\n${escapeMd(view.text)}`, {
          parse_mode: "MarkdownV2",
          reply_markup: interactionKeyboard(view)
        });
      }
    });

    this.bot.command("health", async (ctx) => {
      const outbox = this.store.outboxCounts();
      const active = this.sessions.getActiveSession();
      await ctx.reply([
        "tele-codex health",
        "",
        `session: ${active ? `${active.status} (${active.label})` : "none active"}`,
        `pending interactions: ${this.store.listPendingActions().length}`,
        `delivery queue: ${outbox.pending} pending, ${outbox.failed} failed`,
        outbox.failed ? "Use /retrydelivery after correcting Telegram connectivity." : "high-signal delivery: healthy"
      ].join("\n"));
    });

    this.bot.command("retrydelivery", async (ctx) => {
      const count = this.store.retryFailedOutbox();
      void this.drainOutbox();
      await ctx.reply(`Queued ${count} failed notification(s) for retry.`);
    });

    this.bot.command("search", async (ctx) => {
      const term = String(ctx.match ?? "").trim();
      if (!term) {
        await ctx.reply("Usage: /search <term>");
        return;
      }
      const threads = await this.sessions.searchRemoteThreads(term, 12);
      if (threads.length === 0) {
        await ctx.reply(`No Codex sessions match: ${term}`);
        return;
      }
      await this.sendThreadPicker(ctx, threads);
    });

    this.bot.command("limits", async (ctx) => {
      const limits = await this.sessions.rateLimits();
      await ctx.reply(formatLimits(limits));
    });

    this.bot.command("progress", async (ctx) => {
      const progress = this.sessions.progress();
      await ctx.reply(progress ? formatProgress(progress) : "No plan has been reported for the active session.");
    });

    this.bot.command("diff", async (ctx) => {
      const diff = this.sessions.diff();
      if (!diff) {
        await ctx.reply("No turn diff has been reported for the active session.");
        return;
      }
      if (diff.length < 3800) {
        await ctx.reply(diff);
      } else {
        const path = join(tmpdir(), `tele-codex-diff-${Date.now()}.patch`);
        await writeFile(path, diff);
        await ctx.replyWithDocument(new InputFile(path, "codex-turn.patch"));
      }
    });

    this.bot.command("goal", async (ctx) => {
      const input = String(ctx.match ?? "").trim();
      if (input.startsWith("start ")) {
        const objective = input.slice(6).trim();
        if (!objective) throw new Error("Goal objective cannot be empty.");
        await ctx.reply(formatGoal(await this.sessions.startGoal(objective)));
        return;
      }
      if (input === "pause") {
        await ctx.reply(formatGoal(await this.sessions.setGoalStatus("paused")));
        return;
      }
      if (input === "resume") {
        await ctx.reply(formatGoal(await this.sessions.setGoalStatus("active")));
        return;
      }
      if (input === "clear") {
        await ctx.reply((await this.sessions.clearGoal()) ? "Goal cleared." : "No goal was active.");
        return;
      }
      if (input) {
        await ctx.reply("Usage: /goal OR /goal start <objective> OR /goal pause|resume|clear");
        return;
      }
      const goal = await this.sessions.goal();
      await ctx.reply(goal ? formatGoal(goal) : "No goal is set for the active session.");
    });

    this.bot.command("processes", async (ctx) => {
      const session = this.sessions.getActiveSession();
      if (!session) {
        await ctx.reply("No active session.");
        return;
      }
      const processes = await this.sessions.backgroundTerminals(session.id);
      if (processes.length === 0) {
        await ctx.reply("No background terminals for the active session.");
        return;
      }
      const keyboard = new InlineKeyboard();
      const lines = processes.map((process, index) => {
        const id = Math.random().toString(36).slice(2, 10);
        this.processSelections.set(id, { sessionId: session.id, processId: process.processId, command: process.command });
        keyboard.text(`Stop ${index + 1}`, `proc:${id}:ask`).row();
        return `${index + 1}. ${process.command}\npid: ${process.osPid ?? process.processId}\ncwd: ${process.cwd}`;
      });
      await ctx.reply(`Background terminals\n\n${lines.join("\n\n")}`, { reply_markup: keyboard });
    });

    this.bot.command("doctor", async (ctx) => {
      const report = await runDoctor(this.config);
      await ctx.reply(formatDoctorReport(report));
    });

    this.bot.command("transcript", async (ctx) => {
      await this.sendTranscript(ctx);
    });

    this.bot.command("pause", async (ctx) => {
      this.sessions.pause();
      await ctx.reply("Paused active session forwarding.");
    });

    this.bot.command("unpause", async (ctx) => {
      this.sessions.resume();
      await ctx.reply("Resumed active session forwarding.");
    });

    this.bot.command("kill", async (ctx) => {
      const active = this.sessions.getActiveSession();
      if (!active) {
        await ctx.reply("No active session.");
        return;
      }
      const keyboard = new InlineKeyboard().text("Confirm kill", `kill:${active.id}:confirm`);
      await ctx.reply(`Interrupt active session?\n${active.id}`, { reply_markup: keyboard });
    });

    this.bot.command("approve", async (ctx) => this.manualDecision(ctx, "accept"));
    this.bot.command("deny", async (ctx) => this.manualDecision(ctx, "decline"));

    this.bot.callbackQuery(/^cb:/, async (ctx) => {
      const token = String(ctx.callbackQuery.data).slice(3);
      const userId = ctx.from.id;
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      try {
        const result = this.interactions.handleCallback(token, chatId, userId);
        if (result.kind === "notice") {
          await ctx.answerCallbackQuery({ text: result.text, show_alert: true });
          return;
        }
        if (result.kind === "submit") {
          await this.sessions.respondAction(result.decision);
          this.store.consumeCallbackToken(token, chatId);
          await this.clearActionKeyboards(result.decision.actionId);
          await ctx.answerCallbackQuery({ text: result.text });
          await ctx.editMessageText(result.text);
          return;
        }
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(result.view.text, { reply_markup: interactionKeyboard(result.view) });
      } catch (error) {
        await ctx.answerCallbackQuery({ text: error instanceof Error ? error.message : "Interaction failed.", show_alert: true });
      }
    });

    this.bot.callbackQuery(/^send:/, async (ctx) => {
      const token = String(ctx.callbackQuery.data).slice(5);
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      try {
        const session = await this.routing.selectPicker(token, chatId, ctx.from.id);
        await ctx.answerCallbackQuery({ text: "Thread selected." });
        await ctx.reply(`Your next message will be sent once to:\n${session.label}\n${session.cwd ?? session.id}\n\nThis compose selection expires in 5 minutes.`);
      } catch (error) {
        await ctx.answerCallbackQuery({ text: error instanceof Error ? error.message : "Could not select thread.", show_alert: true });
      }
    });

    this.bot.callbackQuery(/^panel:/, async (ctx) => {
      const [, action] = String(ctx.callbackQuery.data).split(":");
      try {
        if (action === "refresh") {
          await ctx.answerCallbackQuery({ text: "Refreshed." });
          await this.editOrReplyPanel(ctx);
          return;
        }
        if (action === "status") {
          const active = this.sessions.getActiveSession();
          await ctx.answerCallbackQuery();
          await ctx.reply(active ? this.statusText(active) : "No active session.");
          return;
        }
        if (action === "usage") {
          const active = this.sessions.getActiveSession();
          await ctx.answerCallbackQuery();
          await ctx.reply(active ? formatUsage(this.store.getTokenUsage(active.id)) : "No active session.");
          return;
        }
        if (action === "new") {
          await ctx.answerCallbackQuery({ text: "Choose a project." });
          await this.showWorkspacePicker(ctx);
          return;
        }
        if (action === "resume") {
          await ctx.answerCallbackQuery({ text: "Choose a thread." });
          await this.showThreadPicker(ctx);
          return;
        }
        if (action === "models") {
          await ctx.answerCallbackQuery({ text: "Choose a model." });
          await this.showModelPicker(ctx);
          return;
        }
        if (action === "plan") {
          await this.sessions.setMode("plan");
          await ctx.answerCallbackQuery({ text: "Plan mode enabled." });
          await this.editOrReplyPanel(ctx);
          return;
        }
        if (action === "default") {
          await this.sessions.setMode("default");
          await ctx.answerCallbackQuery({ text: "Default mode enabled." });
          await this.editOrReplyPanel(ctx);
          return;
        }
        if (action === "pause") {
          this.sessions.pause();
          await ctx.answerCallbackQuery({ text: "Paused." });
          await this.editOrReplyPanel(ctx);
          return;
        }
        if (action === "unpause") {
          this.sessions.resume();
          await ctx.answerCallbackQuery({ text: "Input resumed." });
          await this.editOrReplyPanel(ctx);
          return;
        }
        if (action === "transcript") {
          await ctx.answerCallbackQuery({ text: "Exporting transcript." });
          await this.sendTranscript(ctx);
          return;
        }
      } catch (error) {
        await ctx.answerCallbackQuery({ text: error instanceof Error ? error.message : "Panel action failed.", show_alert: true });
      }
    });

    this.bot.callbackQuery(/^kill:/, async (ctx) => {
      const [, sessionId, confirm] = String(ctx.callbackQuery.data).split(":");
      if (sessionId && confirm === "confirm") {
        await this.sessions.kill(sessionId);
        await ctx.answerCallbackQuery({ text: "Interrupted." });
        await ctx.editMessageText(`Interrupted session:\n${sessionId}`);
      }
    });

    this.bot.callbackQuery(/^archive:/, async (ctx) => {
      const [, sessionId, confirm] = String(ctx.callbackQuery.data).split(":");
      if (sessionId && confirm === "confirm") {
        await this.sessions.archive(sessionId);
        await ctx.answerCallbackQuery({ text: "Archived." });
        await ctx.editMessageText(`Archived session:\n${sessionId}`);
      }
    });

    this.bot.callbackQuery(/^forget:/, async (ctx) => {
      const [, sessionId, confirm] = String(ctx.callbackQuery.data).split(":");
      if (sessionId && confirm === "confirm") {
        await this.sessions.forget(sessionId);
        await ctx.answerCallbackQuery({ text: "Local metadata forgotten." });
        await ctx.editMessageText(`Forgot local thread metadata:\n${sessionId}`);
      }
    });

    this.bot.callbackQuery(/^proj:/, async (ctx) => {
      const [, selectionId] = String(ctx.callbackQuery.data).split(":");
      const project = selectionId ? this.projectSelections.get(selectionId) : undefined;
      if (!project) {
        await ctx.answerCallbackQuery({ text: "Project selection expired. Run /new again.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Starting Codex..." });
      await this.startProjectSession(ctx, project);
    });

    this.bot.callbackQuery(/^thread:/, async (ctx) => {
      const [, selectionId] = String(ctx.callbackQuery.data).split(":");
      const thread = selectionId ? this.threadSelections.get(selectionId) : undefined;
      if (!thread) {
        await ctx.answerCallbackQuery({ text: "Thread selection expired. Run /resume again.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Resuming thread..." });
      const session = await this.sessions.resumeThread(thread.id);
      await ctx.reply(`Resumed Codex session:\n${session.label}\n${session.id}`);
    });

    this.bot.callbackQuery(/^model:/, async (ctx) => {
      const [, selectionId] = String(ctx.callbackQuery.data).split(":");
      const model = selectionId ? this.modelSelections.get(selectionId) : undefined;
      if (!model) {
        await ctx.answerCallbackQuery({ text: "Model selection expired. Run /model again.", show_alert: true });
        return;
      }
      await this.sessions.setModel(model.id);
      await ctx.answerCallbackQuery({ text: "Model changed." });
      await ctx.reply(`Model changed for subsequent turns:\n${model.id}`);
    });

    this.bot.callbackQuery(/^sess:/, async (ctx) => {
      const [, action, sessionId] = String(ctx.callbackQuery.data).split(":");
      if (!sessionId) {
        await ctx.answerCallbackQuery({ text: "Missing session.", show_alert: true });
        return;
      }
      try {
        if (action === "use") {
          const session = await this.routing.setSticky(ctx.chat!.id, ctx.from.id, sessionId);
          await ctx.answerCallbackQuery({ text: "Sticky route updated." });
          await ctx.reply(`Sticky route for this chat and user:\n${session.label}\n${session.id}`);
          return;
        }
        if (action === "resume") {
          const session = await this.sessions.resumeSession(sessionId);
          await ctx.answerCallbackQuery({ text: "Session resumed." });
          await ctx.reply(`Resumed session:\n${session.label}\n${session.id}`);
          return;
        }
        if (action === "pause") {
          this.sessions.pause(sessionId);
          await ctx.answerCallbackQuery({ text: "Paused." });
          return;
        }
        if (action === "unpause") {
          this.sessions.resume(sessionId);
          await ctx.answerCallbackQuery({ text: "Resumed forwarding." });
          return;
        }
        if (action === "transcript") {
          await ctx.answerCallbackQuery({ text: "Exporting transcript." });
          await this.sendTranscript(ctx, sessionId);
          return;
        }
        if (action === "detach") {
          await this.sessions.detach(sessionId);
          await ctx.answerCallbackQuery({ text: "Detached." });
          await ctx.editMessageText(`Detached thread:\n${sessionId}\nUse /sessions to resume it.`);
          return;
        }
        if (action === "archive") {
          const keyboard = new InlineKeyboard().text("Confirm archive", `archive:${sessionId}:confirm`);
          await ctx.answerCallbackQuery({ text: "Confirm archive." });
          await ctx.reply(`Archive thread?\n${sessionId}`, { reply_markup: keyboard });
          return;
        }
        if (action === "forget") {
          const keyboard = new InlineKeyboard().text("Confirm forget", `forget:${sessionId}:confirm`);
          await ctx.answerCallbackQuery({ text: "Confirm forget." });
          await ctx.reply(`Forget local metadata? Codex history is not deleted.\n${sessionId}`, { reply_markup: keyboard });
          return;
        }
        if (action === "kill") {
          const keyboard = new InlineKeyboard().text("Confirm kill", `kill:${sessionId}:confirm`);
          await ctx.answerCallbackQuery({ text: "Confirm kill." });
          await ctx.reply(`Interrupt session?\n${sessionId}`, { reply_markup: keyboard });
        }
      } catch (error) {
        await ctx.answerCallbackQuery({ text: error instanceof Error ? error.message : "Session action failed.", show_alert: true });
      }
    });

    this.bot.callbackQuery(/^legacy:/, async (ctx) => {
      const token = String(ctx.callbackQuery.data).slice(7);
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      const callback = this.store.consumeCallbackToken(token, chatId, ctx.from.id);
      if (!callback) {
        await ctx.answerCallbackQuery({ text: "This legacy tmux control expired, was used, or belongs to another chat.", show_alert: true });
        return;
      }
      const payload = callback.payload as { target?: string; attachmentId?: string; action?: string; strategy?: string; expectedVersion?: number };
      let answered = false;
      try {
        if (callback.operation === "legacy-tmux-attach" && payload.target) {
          await ctx.answerCallbackQuery({ text: "Attaching legacy tmux fallback..." });
          answered = true;
          const attachment = await this.legacyTmux.attach(payload.target, chatId, `tmux ${payload.target}`);
          await ctx.reply(`Attached legacy tmux pane ${payload.target}:\n${attachment.id}\n\nSending input test...`);
          await this.sendProbeResult(chatId, ctx.from.id, await this.legacyTmux.probe(attachment.id, chatId));
          return;
        }
        if (callback.operation !== "legacy-tmux-probe" || !payload.attachmentId || !payload.action) {
          throw new Error("Invalid legacy tmux control.");
        }
        const attachment = this.store.getLegacyTmuxAttachment(payload.attachmentId);
        if (!attachment || attachment.chatId !== chatId || attachment.updatedAt !== payload.expectedVersion) {
          throw new Error("This legacy tmux attachment changed or belongs to another chat. Run /tmux again.");
        }
        await ctx.answerCallbackQuery({ text: "Updating legacy input test..." });
        answered = true;
        if (payload.action === "retry") {
          await this.sendProbeResult(chatId, ctx.from.id, await this.legacyTmux.probe(attachment.id, chatId));
        } else if (payload.action === "next") {
          await this.sendProbeResult(chatId, ctx.from.id, await this.legacyTmux.tryNextStrategy(attachment.id, chatId));
        } else if (payload.action === "key" && payload.strategy) {
          await this.sendProbeResult(chatId, ctx.from.id, await this.legacyTmux.probe(attachment.id, chatId, payload.strategy));
        } else if (payload.action === "ready") {
          this.legacyTmux.markReady(attachment.id, chatId);
          await ctx.reply("Marked legacy tmux input as ready. Continue with /tmux send <attachmentId> <text>.");
        } else if (payload.action === "manual") {
          this.legacyTmux.markPasteOnly(attachment.id, chatId);
          await ctx.reply("Marked as paste-only. Telegram can paste text, but you must submit locally.");
        } else {
          throw new Error("Invalid legacy tmux action.");
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Legacy tmux action failed.";
        if (answered) await ctx.reply(detail);
        else await ctx.answerCallbackQuery({ text: detail, show_alert: true });
      }
    });

    this.bot.callbackQuery(/^proc:/, async (ctx) => {
      const [, id, action] = String(ctx.callbackQuery.data).split(":");
      const selection = id ? this.processSelections.get(id) : undefined;
      if (!selection) {
        await ctx.answerCallbackQuery({ text: "Process selection expired.", show_alert: true });
        return;
      }
      if (action === "ask") {
        const keyboard = new InlineKeyboard().text("Confirm stop", `proc:${id}:confirm`);
        await ctx.answerCallbackQuery();
        await ctx.reply(`Terminate this background process?\n${selection.command}`, { reply_markup: keyboard });
        return;
      }
      const terminated = await this.sessions.terminateBackgroundTerminal(selection.processId, selection.sessionId);
      this.processSelections.delete(id!);
      await ctx.answerCallbackQuery({ text: terminated ? "Terminated." : "Process was already gone." });
      await ctx.editMessageText(terminated ? "Background process terminated." : "Background process was already gone.");
    });

    this.bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;
      if (text.startsWith("/")) return;
      const interaction = this.interactions.handleText(ctx.chat.id, ctx.from.id, text);
      if (interaction) {
        if (interaction.kind === "submit") {
          try {
            await this.sessions.respondAction(interaction.decision);
            await this.clearActionKeyboards(interaction.decision.actionId);
            await ctx.reply(interaction.text);
          } catch (error) {
            await ctx.reply(error instanceof Error ? error.message : "Could not submit answers.");
          }
        } else if (interaction.kind === "view") {
          await ctx.reply(interaction.view.text, { reply_markup: interactionKeyboard(interaction.view) });
        } else {
          await ctx.reply(interaction.text);
        }
        return;
      }
      await this.forwardUserText(ctx, text, ctx.message.reply_to_message?.message_id);
    });
  }

  private async showWorkspacePicker(ctx: Context): Promise<void> {
    const [text, options] = await this.workspacePickerMessage();
    await ctx.reply(text, options);
  }

  private async showPanel(ctx: Context): Promise<void> {
    const active = this.sessions.getActiveSession();
    await ctx.reply(active ? this.panelText(active) : "No active Codex session.", { reply_markup: panelKeyboard(active) });
  }

  private async editOrReplyPanel(ctx: Context): Promise<void> {
    const active = this.sessions.getActiveSession();
    const text = active ? this.panelText(active) : "No active Codex session.";
    try {
      await ctx.editMessageText(text, { reply_markup: panelKeyboard(active) });
    } catch {
      await ctx.reply(text, { reply_markup: panelKeyboard(active) });
    }
  }

  private statusText(session: StoredSession): string {
    return formatStatus(session, this.store.countPendingActions(session.id), this.store.getTokenUsage(session.id));
  }

  private panelText(session: StoredSession): string {
    const usage = this.store.getTokenUsage(session.id);
    const pending = this.store.countPendingActions(session.id);
    const delivery = this.store.outboxCounts();
    const goal = this.store.getGoal(session.id);
    const limits = this.store.getRateLimits();
    return [
      "tele-codex panel",
      "",
      `${session.label}`,
      `${session.adapter} | ${session.status}${session.paused ? " | paused" : ""}`,
      session.cwd,
      `pending: ${pending}`,
      `delivery: ${delivery.pending} queued, ${delivery.failed} failed`,
      goal ? `goal: ${goal.status}` : undefined,
      limits ? `limits: ${limits.usedPercent.toFixed(1)}% used` : undefined,
      usage ? `usage: ${usage.total.totalTokens.toLocaleString("en-US")} tokens` : "usage: none yet"
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async sendStartupPicker(): Promise<void> {
    const sessions = this.sessions.listSessions().filter((session) => session.status !== "stopped");
    const lastActiveId = this.sessions.getLastActiveSessionId();
    const orphaned = this.store.getRuntimeValue<number>("startup_orphaned_actions") ?? 0;
    const orphanedActionIds = this.store.getRuntimeValue<string[]>("startup_orphaned_action_ids") ?? [];
    await Promise.all(orphanedActionIds.map((actionId) => this.finalizeActionMessages(
      actionId,
      "This request was invalidated when tele-codex restarted. Resume the thread and retry the original command."
    )));
    for (const chatId of this.allowedDeliveryChats()) {
      try {
        if (sessions.length > 0) {
          const keyboard = sessionsKeyboard(sessions) as unknown as { inline_keyboard: unknown[][] };
          this.store.enqueueOutbox(`startup-recovery:${this.runtimeId}`, chatId, {
            text: `tele-codex restarted. Threads are not resumed automatically.\n${lastActiveId ? `Last active: ${lastActiveId}\n` : ""}${orphaned ? `${orphaned} previous pending request(s) were marked orphaned.\n` : ""}\nRecoverable sessions:\n\n${formatSessions(sessions)}`,
            keyboard: keyboard.inline_keyboard
          });
        }
        const [text, options] = await this.workspacePickerMessage();
        await this.bot.api.sendMessage(chatId, text, options);
      } catch (error) {
        this.logger.warn({ error, chatId }, "failed to send startup picker");
      }
    }
    void this.drainOutbox();
    if (orphaned) this.store.setRuntimeValue("startup_orphaned_actions", 0);
    if (orphanedActionIds.length > 0) this.store.setRuntimeValue("startup_orphaned_action_ids", []);
  }

  private async workspacePickerMessage(): Promise<[string, { reply_markup: InlineKeyboard }]> {
    const projects = await listWorkspaceProjects(this.config.workspaceRoot);
    const keyboard = new InlineKeyboard();
    this.projectSelections.clear();
    projects.forEach((project, index) => {
      const selectionId = Math.random().toString(36).slice(2, 10);
      this.projectSelections.set(selectionId, project);
      keyboard.text(`${index + 1}. ${project.name}`, `proj:${selectionId}`).row();
    });
    const text =
      projects.length === 0
        ? `No project folders found under ${this.config.workspaceRoot}.`
        : `Start Codex in a workspace project:\n\n${projects
            .map((project, index) => `${index + 1}. ${project.name}`)
            .join("\n")}\n\nUse /new <project-or-path> for manual entry.`;
    return [text, { reply_markup: keyboard }];
  }

  private async showThreadPicker(ctx: Context): Promise<void> {
    const threads = await this.sessions.listRemoteThreads(12);
    if (threads.length === 0) {
      await ctx.reply("No previous Codex sessions found.");
      return;
    }

    await this.sendThreadPicker(ctx, threads);
  }

  private async showSendPicker(ctx: Context): Promise<void> {
    const remote = await this.sessions.listRemoteThreads(12);
    const local = this.store.listSessions(true);
    const threads = [...remote];
    for (const session of local) {
      if (!session.codexThreadId || threads.some((thread) => thread.id === session.codexThreadId)) continue;
      const thread: CodexThreadSummary = {
        id: session.codexThreadId,
        name: session.label,
        status: session.status,
        updatedAt: Math.floor(session.updatedAt / 1000)
      };
      if (session.cwd) thread.cwd = session.cwd;
      threads.push(thread);
    }
    if (threads.length === 0) {
      await ctx.reply("No recent or recoverable Codex threads found. Use /new to start one.");
      return;
    }

    const keyboard = new InlineKeyboard();
    threads.slice(0, 12).forEach((thread, index) => {
      const attached = this.store.getSessionByCodexThreadId(thread.id);
      const token = this.routing.pickerToken(ctx.chat!.id, ctx.from!.id, thread, attached);
      keyboard.text(`${index + 1}. Send to thread`.slice(0, 60), `send:${token}`).row();
    });
    await ctx.reply(formatSendPicker(threads.slice(0, 12), this.store), { reply_markup: keyboard });
  }

  private async sendThreadPicker(ctx: Context, threads: CodexThreadSummary[]): Promise<void> {
    const keyboard = new InlineKeyboard();
    this.threadSelections.clear();
    threads.forEach((thread, index) => {
      const selectionId = Math.random().toString(36).slice(2, 10);
      this.threadSelections.set(selectionId, thread);
      keyboard.text(`${index + 1}. Resume`, `thread:${selectionId}`).row();
    });

    await ctx.reply(formatThreads(threads), { reply_markup: keyboard });
  }

  private async resumeTarget(target: string): Promise<StoredSession | SessionRef> {
    const local = this.store.getSession(target);
    return local ? this.sessions.resumeSession(local.id) : this.sessions.resumeThread(target);
  }

  private async showModelPicker(ctx: Context): Promise<void> {
    const models = await this.sessions.listModels(20);
    if (models.length === 0) {
      await ctx.reply("No models returned by the app-server.");
      return;
    }

    const keyboard = new InlineKeyboard();
    this.modelSelections.clear();
    models.slice(0, 12).forEach((model, index) => {
      const selectionId = Math.random().toString(36).slice(2, 10);
      this.modelSelections.set(selectionId, model);
      keyboard.text(`${index + 1}. ${model.id}`.slice(0, 60), `model:${selectionId}`).row();
    });

    await ctx.reply(formatModels(models), { reply_markup: keyboard });
  }

  private async showAttachPicker(ctx: Context): Promise<void> {
    const panes = await this.legacyTmux.listPanes();
    if (panes.length === 0) {
      await ctx.reply("No tmux panes found. Start Codex in tmux, then run /attach again.");
      return;
    }

    const keyboard = new InlineKeyboard();
    panes.slice(0, 12).forEach((pane, index) => {
      const token = this.legacyCallbackToken(ctx.chat!.id, ctx.from!.id, "legacy-tmux-attach", { target: pane.target });
      keyboard.text(`${index + 1}. ${pane.target} ${pane.command}`, `legacy:${token}`).row();
    });

    const text = panes
      .slice(0, 12)
      .map((pane, index) => {
        const preview = pane.preview.split(/\r?\n/).slice(-3).join(" ").slice(0, 140);
        return `${index + 1}. ${pane.target} ${pane.active ? "[active]" : ""}\n${pane.command} ${pane.title}\n${preview}`;
      })
      .join("\n\n");
    await ctx.reply(`Select a tmux pane to attach:\n\n${text}`, { reply_markup: keyboard });
  }

  private async sendProbeResult(chatId: number | undefined, userId: number, result: ProbeResult): Promise<void> {
    if (!chatId) return;
    const attachment = this.store.getLegacyTmuxAttachment(result.sessionId);
    if (!attachment || attachment.chatId !== chatId) throw new Error("Legacy tmux attachment is unavailable for this chat.");
    await this.bot.api.sendMessage(chatId, formatProbeResult(result), {
      reply_markup: this.legacyProbeKeyboard(chatId, userId, attachment)
    });
  }

  private legacyProbeKeyboard(chatId: number, userId: number, attachment: LegacyTmuxAttachment): InlineKeyboard {
    const callback = (action: string, strategy?: string) => this.legacyCallbackToken(chatId, userId, "legacy-tmux-probe", {
      attachmentId: attachment.id,
      action,
      strategy,
      expectedVersion: attachment.updatedAt
    });
    return new InlineKeyboard()
      .text("Codex answered", `legacy:${callback("ready")}`).row()
      .text("Test Enter", `legacy:${callback("key", "enter")}`)
      .text("Test F12", `legacy:${callback("key", "f12")}`).row()
      .text("Retry test", `legacy:${callback("retry")}`)
      .text("Try next key", `legacy:${callback("next")}`).row()
      .text("Paste only", `legacy:${callback("manual")}`);
  }

  private legacyCallbackToken(chatId: number, userId: number, operation: string, payload: unknown): string {
    const token = createNonce(12);
    this.store.putCallbackToken({
      token,
      actionId: createId("legacy_tmux"),
      chatId,
      userId,
      operation,
      payload,
      expiresAt: Date.now() + 10 * 60_000
    });
    return token;
  }

  private async startProjectSession(ctx: Context, project: WorkspaceProject): Promise<void> {
    try {
      await this.ensureDirectory(project.path);
      const session = await this.sessions.newSession({ cwd: project.path, label: project.name });
      await ctx.reply(`Started app-server session in ${project.name}:\n${session.id}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown startup error.";
      this.logger.error({ err: error, project }, "failed to start Codex app-server session from Telegram");
      await ctx.reply(
        [
          `Could not start Codex in ${project.name}.`,
          "",
          detail,
          "",
          "Check that `codex app-server --listen stdio://` can start from the same environment as tele-codex."
        ].join("\n")
      );
    }
  }

  private async forwardUserText(ctx: Context, text: string, replyToMessageId?: number): Promise<void> {
    try {
      const routed = await this.routing.routeText(ctx.chat!.id, ctx.from!.id, text, replyToMessageId);
      if (!routed) {
        await ctx.reply("Choose a destination first: run /send, reply to a tele-codex agent message, or opt into sticky routing with /use <thread>.");
      }
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : "Could not forward message to Codex.");
    }
  }

  private async sendTranscript(ctx: Context, sessionId?: string): Promise<void> {
    const transcript = this.sessions.transcript(sessionId);
    if (!transcript.trim()) {
      await ctx.reply("No transcript has been recorded for this session yet.");
      return;
    }
    const active = sessionId ? this.store.getSession(sessionId) : this.sessions.getActiveSession();
    const filename = `tele-codex-${active?.label.replace(/[^a-z0-9_.-]+/gi, "-") ?? "session"}-${Date.now()}.txt`;
    const path = join(tmpdir(), filename);
    await writeFile(path, transcript);
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    await this.bot.api.sendDocument(chatId, new InputFile(path, filename));
  }

  private async manualDecision(ctx: Context, decision: ApprovalDecision): Promise<void> {
    const actionId = String(ctx.match ?? "").trim();
    if (!actionId) {
      await ctx.reply(`Usage: /${decision === "accept" ? "approve" : "deny"} <actionId>`);
      return;
    }
    await this.sessions.respondAction({ actionId, decision });
    await this.clearActionKeyboards(actionId);
    await ctx.reply("Decision submitted; waiting for Codex confirmation.");
  }

  private async forwardCodexEvents(): Promise<void> {
    for await (const event of this.sessions.events()) {
      try {
        await this.handleCodexEvent(event);
      } catch (error) {
        this.logger.error({ error, eventType: event.type, sessionId: event.sessionId }, "failed to ingest Codex event");
      }
    }
  }

  private async handleCodexEvent(event: CodexEvent): Promise<void> {
    if (event.type === "agentMessage") {
      this.store.appendTranscript(event.sessionId, event.text, { turnId: event.turnId, itemId: event.itemId });
      const session = this.store.getSession(event.sessionId);
      if (!session || this.store.listSessionChats(event.sessionId).length === 0) return;
      this.bufferAgentMessage(event.sessionId, event.text, session);
      return;
    }

    if (event.type === "actionResolved") {
      await this.finalizeActionMessages(event.actionId, "Codex confirmed the response.");
      return;
    }

    if (event.type === "actionOrphaned") {
      await this.finalizeActionMessages(event.actionId, event.message);
      return;
    }

    if (event.type === "approvalRequested" || event.type === "questionAsked") {
      for (const chatId of this.deliveryChatsForSession(event.sessionId)) {
        const view = this.interactions.actionView(event.action, chatId);
        const keyboard = interactionKeyboard(view) as unknown as { inline_keyboard: unknown[][] };
        this.store.enqueueOutbox(
          `action:${event.action.id}`,
          chatId,
          {
            text: `${formatAction(event.action)}\n\n${escapeMd(view.text)}`,
            parseMode: "MarkdownV2",
            keyboard: keyboard.inline_keyboard
          },
          event.action.id
        );
      }
      void this.drainOutbox();
      return;
    }

    if (event.type === "taskCompleted" || event.type === "error" || event.type === "blocked") {
      if (event.type === "taskCompleted") await this.flushAgentMessage(event.sessionId);
      const text =
        event.type === "taskCompleted"
          ? `Codex task ${event.status}: ${event.summary}`
          : event.type === "error"
            ? `Codex error: ${event.message}`
            : `Codex blocked: ${event.reason}`;
      for (const chatId of this.deliveryChatsForSession(event.sessionId)) {
        const discriminator = event.type === "taskCompleted" ? event.turnId ?? event.status : createId(event.type);
        this.store.enqueueOutbox(
          `${event.type}:${event.sessionId}:${discriminator}`,
          chatId,
          { text: truncateMiddle(text) }
        );
      }
      void this.drainOutbox();
      return;
    }

    if (event.type === "goalChanged") {
      if (!["blocked", "usageLimited", "budgetLimited", "complete"].includes(event.goal.status)) return;
      for (const chatId of this.deliveryChatsForSession(event.sessionId)) {
        this.store.enqueueOutbox(`goal:${event.sessionId}:${event.goal.status}:${event.goal.updatedAt}`, chatId, {
          text: formatGoal(event.goal)
        });
      }
      void this.drainOutbox();
      return;
    }

    if (event.type === "rateLimitsChanged" && (event.recovered || event.limits.usedPercent >= this.config.rateLimitWarnPercent)) {
      const bucket = event.limits.usedPercent >= 100 ? 100 : event.limits.usedPercent >= 95 ? 95 : this.config.rateLimitWarnPercent;
      for (const chatId of this.deliveryChatsForSession(event.sessionId)) {
        this.store.enqueueOutbox(`limits:${event.recovered ? "recovered" : bucket}:${event.limits.resetsAt ?? "unknown"}`, chatId, {
          text: `${event.recovered ? "Codex rate limits recovered" : "Codex rate-limit warning"}\n\n${formatLimits(event.limits)}`
        });
      }
      void this.drainOutbox();
      return;
    }

    if (event.type === "warning") {
      for (const chatId of this.deliveryChatsForSession(event.sessionId)) {
        this.store.enqueueOutbox(`warning:${event.sessionId}:${createId("event")}`, chatId, {
          text: `Codex warning: ${event.message}`
        });
      }
      void this.drainOutbox();
    }
  }

  private async drainOutbox(): Promise<void> {
    if (this.drainingOutbox) return;
    this.drainingOutbox = true;
    try {
      for (const message of this.store.dueOutbox()) {
        try {
          if (message.actionId) {
            const action = this.store.getPendingAction(message.actionId);
            if (!action || action.status !== "pending" || action.expiresAt <= Date.now()) {
              this.store.markOutboxSent(message.id);
              continue;
            }
          }
          const options: Record<string, unknown> = {};
          if (message.payload.parseMode) options.parse_mode = message.payload.parseMode;
          if (message.payload.keyboard) options.reply_markup = { inline_keyboard: message.payload.keyboard };
          const sent = await this.bot.api.sendMessage(message.chatId, message.payload.text, options as never);
          this.store.markOutboxSent(message.id);
          if (message.actionId) this.store.setTelegramMessage(message.actionId, message.chatId, sent.message_id);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.store.retryOutbox(message.id, message.attempts + 1, detail);
          this.logger.warn({ error, outboxId: message.id, attempts: message.attempts + 1 }, "Telegram delivery failed");
        }
      }
    } finally {
      this.drainingOutbox = false;
    }
  }

  private async clearActionKeyboards(actionId: string): Promise<void> {
    await Promise.all(this.store.listTelegramMessages(actionId).map(async ({ chatId, messageId }) => {
      try {
        await this.bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: [] } });
      } catch (error) {
        this.logger.debug({ error, actionId, chatId, messageId }, "could not clear resolved action keyboard");
      }
    }));
  }

  private async finalizeActionMessages(actionId: string, text: string): Promise<void> {
    await Promise.all(this.store.listTelegramMessages(actionId).map(async ({ chatId, messageId }) => {
      try {
        await this.bot.api.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: [] } });
      } catch (error) {
        this.logger.debug({ error, actionId, chatId, messageId }, "could not invalidate action message");
        try {
          await this.bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: [] } });
        } catch (markupError) {
          this.logger.debug({ error: markupError, actionId, chatId, messageId }, "could not clear action keyboard");
        }
      }
    }));
  }

  private bufferAgentMessage(sessionId: string, text: string, session?: StoredSession): void {
    if (!text.trim()) return;

    const existing = this.messageBuffers.get(sessionId);
    if (existing) {
      existing.text = appendAgentMessageChunk(existing.text, text, session);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => void this.flushAgentMessage(sessionId), 1200);
      return;
    }

    const timer = setTimeout(() => void this.flushAgentMessage(sessionId), 1200);
    this.messageBuffers.set(sessionId, { text: appendAgentMessageChunk("", text, session), timer });
  }

  private async flushAgentMessage(sessionId: string): Promise<void> {
    const buffered = this.messageBuffers.get(sessionId);
    if (!buffered) return;
    this.messageBuffers.delete(sessionId);

    const session = this.store.getSession(sessionId);
    const text = formatAgentMessage(session, buffered.text);
    for (const chatId of this.store.listSessionChats(sessionId)) {
      const sent = await this.bot.api.sendMessage(chatId, text);
      this.store.setMessageThread(chatId, sent.message_id, sessionId);
    }
  }

  private async ensureDirectory(path: string): Promise<void> {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error(`Not a directory: ${path}`);
  }

  private allowedDeliveryChats(): number[] {
    if (this.config.allowedChatIds.size > 0) return [...this.config.allowedChatIds];
    return [...this.config.allowedUserIds];
  }

  private deliveryChatsForSession(sessionId: string): number[] {
    const routed = this.store.listSessionChats(sessionId);
    return routed.length > 0 ? routed : this.allowedDeliveryChats();
  }
}

function interactionKeyboard(view: InteractionView): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const row of view.rows) {
    for (const button of row) {
      if (button.url) keyboard.url(button.label, button.url);
      else if (button.callbackData) keyboard.text(button.label, button.callbackData);
    }
    keyboard.row();
  }
  return keyboard;
}

function formatSendPicker(threads: CodexThreadSummary[], store: Store): string {
  return [
    "Choose a Codex thread for one message",
    "",
    ...threads.map((thread, index) => {
      const local = store.getSessionByCodexThreadId(thread.id);
      const label = thread.name || thread.preview || local?.label || thread.id;
      const updatedSeconds = thread.updatedAt ?? (local ? Math.floor(local.updatedAt / 1000) : undefined);
      return [
        `${index + 1}. ${label.slice(0, 100)}`,
        thread.cwd || local?.cwd,
        `attachment: ${local?.status ?? "recoverable"}`,
        `turn: ${local?.activeTurnId ? "active" : "idle"}`,
        `updated: ${updatedSeconds ? new Date(updatedSeconds * 1000).toISOString() : "unknown"}`
      ].filter(Boolean).join("\n");
    }),
    "",
    "The selection applies only to your next message and expires in 5 minutes."
  ].join("\n\n");
}

function sessionsKeyboard(sessions: StoredSession[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  sessions.slice(0, 10).forEach((session, index) => {
    const resumable = session.status !== "archived";
    const usable =
      !session.paused &&
      (session.status === "attached" ||
        session.status === "idle" ||
        session.status === "active" ||
        session.status === "blocked");
    const action = usable ? "use" : resumable ? "resume" : undefined;
    if (action) {
      keyboard.text(`${index + 1}. ${action === "resume" ? "Resume thread" : "Use"}`, `sess:${action}:${session.id}`);
    }
    keyboard
      .text("Transcript", `sess:transcript:${session.id}`)
      .row();
    if (usable) keyboard.text("Detach", `sess:detach:${session.id}`).text("Archive", `sess:archive:${session.id}`).row();
    keyboard.text("Forget local", `sess:forget:${session.id}`).row();
  });
  return keyboard;
}

function panelKeyboard(session?: StoredSession): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("Refresh", "panel:refresh")
    .text("Status", "panel:status")
    .text("Usage", "panel:usage")
    .row()
    .text("New", "panel:new")
    .text("Resume", "panel:resume")
    .text("Model", "panel:models")
    .row()
    .text("Plan", "panel:plan")
    .text("Default", "panel:default")
    .row();
  if (session) {
    keyboard
      .text(session.paused ? "Resume input" : "Pause input", `panel:${session.paused ? "unpause" : "pause"}`)
      .text("Transcript", "panel:transcript")
      .row();
  }
  return keyboard;
}

function formatModels(models: CodexModelSummary[]): string {
  return [
    "Available models",
    "",
    ...models.slice(0, 20).map((model, index) => {
      const description = model.description ? ` - ${model.description.slice(0, 100)}` : "";
      return `${index + 1}. ${model.id}${model.displayName !== model.id ? ` (${model.displayName})` : ""}${description}`;
    }),
    "",
    "Use /model <id> to change the active app-server session."
  ].join("\n");
}

function formatLimits(limits: RateLimitSummary | undefined): string {
  if (!limits) return "No Codex account limit information is available.";
  return [
    "Codex account limits",
    "",
    `used: ${limits.usedPercent.toFixed(1)}%`,
    limits.planType ? `plan: ${limits.planType}` : undefined,
    limits.windowDurationMins ? `window: ${limits.windowDurationMins} minutes` : undefined,
    limits.resetsAt ? `resets: ${new Date(limits.resetsAt * 1000).toISOString()}` : undefined,
    `updated: ${new Date(limits.updatedAt).toISOString()}`
  ].filter(Boolean).join("\n");
}

function formatProgress(progress: SessionProgress): string {
  return [
    "Active turn plan",
    progress.explanation ? `\n${progress.explanation}` : undefined,
    "",
    ...progress.plan.map((step) => `${step.status === "completed" ? "OK" : step.status === "inProgress" ? ">" : "-"} ${step.step}`),
    "",
    `updated: ${new Date(progress.updatedAt).toISOString()}`
  ].filter((value) => value !== undefined).join("\n");
}

function formatGoal(goal: ThreadGoalSummary): string {
  return [
    "Codex goal",
    "",
    goal.objective,
    "",
    `status: ${goal.status}`,
    `tokens: ${goal.tokensUsed}${goal.tokenBudget ? ` / ${goal.tokenBudget}` : ""}`,
    `time: ${goal.timeUsedSeconds}s`,
    `updated: ${new Date(goal.updatedAt).toISOString()}`
  ].join("\n");
}

function formatProbeResult(result: ProbeResult): string {
  const header = result.status === "stale" ? "Input test could not reach pane" : "Confirm input test";
  return [
    header,
    "",
    `session: ${result.sessionId}`,
    `strategy: ${result.strategy}`,
    `probe: ${result.probe}`,
    `status: ${result.status}`,
    "",
    result.detail,
    "",
    "Look at the Codex pane. If Codex answered the probe, press Codex answered. If the text only appeared in the input box or made a new line, press Try next key.",
    result.preview ? `\nRecent pane preview:\n${result.preview}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

function parseAppServerCommand(match: string | undefined): string {
  const value = String(match ?? "").trim();
  if (value.startsWith("appserver ")) return value.slice(10).trim();
  if (value === "appserver") return "";
  return value;
}

function formatLegacyAttachments(attachments: LegacyTmuxAttachment[]): string {
  if (attachments.length === 0) return "No legacy tmux attachments for this chat.";
  return [
    "Legacy tmux fallback attachments",
    "",
    ...attachments.map((item) => `${item.id}\n${item.target} | ${item.status} | ${item.inputStatus}\n${item.label}`)
  ].join("\n\n");
}
