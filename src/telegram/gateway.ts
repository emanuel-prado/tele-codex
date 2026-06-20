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
import type { ProbeResult, TmuxPane } from "../adapters/pty-adapter.js";
import { formatDoctorReport, runDoctor } from "../runtime/doctor.js";
import { parseResumeCommand } from "./resume-command.js";
import { PendingInteractionManager, type InteractionView } from "./pending-interaction.js";
import { createId } from "../utils/ids.js";

export class TelegramGateway {
  private readonly bot: Bot;
  private readonly runtimeId = createId("runtime");
  private readonly messageBuffers = new Map<string, { text: string; timer: NodeJS.Timeout }>();
  private readonly paneSelections = new Map<string, TmuxPane>();
  private readonly projectSelections = new Map<string, WorkspaceProject>();
  private readonly threadSelections = new Map<string, CodexThreadSummary>();
  private readonly modelSelections = new Map<string, CodexModelSummary>();
  private readonly processSelections = new Map<string, { sessionId: string; processId: string; command: string }>();
  private readonly interactions: PendingInteractionManager;
  private outboxTimer: NodeJS.Timeout | undefined;
  private actionSweepTimer: NodeJS.Timeout | undefined;
  private drainingOutbox = false;

  constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionManager,
    private readonly store: Store,
    private readonly policy: PolicyEngine,
    private readonly logger: Logger
  ) {
    this.bot = new Bot(config.botToken);
    this.interactions = new PendingInteractionManager(store, config.allowSessionGrants);
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
      { command: "send", description: "Forward slash-prefixed text to Codex" },
      { command: "attach", description: "Attach app-server thread or tmux fallback" },
      { command: "tmux", description: "Attach tmux fallback session" },
      { command: "testinput", description: "Test tmux fallback input" },
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
      { command: "kill", description: "Interrupt/stop active session" },
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
          "/sessions - list and control sessions",
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
          "/send <text> - forward slash-prefixed text to Codex",
          "/attach appserver <threadId> - attach Codex thread",
          "/attach tmux <target> - attach a specific tmux pane",
          "/tmux - list tmux panes to attach as a fallback",
          "/testinput - test tmux input/submit readiness",
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
          "Plain text is forwarded to the active Codex session."
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
      const sessions = this.sessions.listSessions();
      await ctx.reply(formatSessions(sessions), { reply_markup: sessionsKeyboard(sessions) });
    });

    this.bot.command("new", async (ctx) => {
      const { adapter, rest } = parseAdapterCommand(ctx.match);
      if (!adapter && !rest) {
        await this.showWorkspacePicker(ctx);
        return;
      }
      if (adapter === "appserver" && !rest) {
        await this.showWorkspacePicker(ctx);
        return;
      }
      if (adapter === "pty") {
        const opts: { adapter: "pty"; prompt?: string } = { adapter };
        if (rest) opts.prompt = rest;
        const session = await this.sessions.newSession(opts);
        await ctx.reply(`Started ${session.adapter} session:\n${session.id}`);
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

    this.bot.command("send", async (ctx) => {
      const text = String(ctx.match ?? "");
      if (!text.trim()) {
        await ctx.reply("Usage: /send <text>");
        return;
      }
      await this.forwardUserText(ctx, text.trimStart());
    });

    this.bot.command("attach", async (ctx) => {
      const parts = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
      const kind = parts[0];
      const target = parts[1];
      if (!kind) {
        await ctx.reply("Usage: /attach appserver <threadId> or /attach tmux <target>. Use /resume to pick previous app-server threads, or /tmux for fallback tmux attachment.");
        return;
      }
      if (kind === "tmux" && target) {
        const session = await this.sessions.attach({ adapter: "pty", tmuxTarget: target });
        await ctx.reply(`Attached tmux pane:\n${session.id}\n\nSending input test...`);
        await this.sendProbeResult(ctx.chat?.id, await this.sessions.probeTmuxSession(session.id));
        return;
      }
      if (kind === "appserver" && target) {
        const session = await this.sessions.attach({ adapter: "appserver", codexThreadId: target });
        await ctx.reply(`Attached app-server thread:\n${session.id}`);
        return;
      }
      await ctx.reply("Usage: /attach tmux <target> OR /attach appserver <threadId>");
    });

    this.bot.command("tmux", async (ctx) => {
      const target = String(ctx.match ?? "").trim();
      if (!target) {
        await this.showAttachPicker(ctx);
        return;
      }
      const session = await this.sessions.attach({ adapter: "pty", tmuxTarget: target });
      await ctx.reply(`Attached tmux fallback pane:\n${session.id}\n\nSending input test...`);
      await this.sendProbeResult(ctx.chat?.id, await this.sessions.probeTmuxSession(session.id));
    });

    this.bot.command("testinput", async (ctx) => {
      await this.showTestInput(ctx);
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
          const session = this.sessions.setActiveSession(sessionId);
          await ctx.answerCallbackQuery({ text: "Active session updated." });
          await ctx.reply(`Active session:\n${session.label}\n${session.id}`);
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
        if (action === "kill") {
          const keyboard = new InlineKeyboard().text("Confirm kill", `kill:${sessionId}:confirm`);
          await ctx.answerCallbackQuery({ text: "Confirm kill." });
          await ctx.reply(`Interrupt session?\n${sessionId}`, { reply_markup: keyboard });
        }
      } catch (error) {
        await ctx.answerCallbackQuery({ text: error instanceof Error ? error.message : "Session action failed.", show_alert: true });
      }
    });

    this.bot.callbackQuery(/^pane:/, async (ctx) => {
      const [, selectionId] = String(ctx.callbackQuery.data).split(":");
      const pane = selectionId ? this.paneSelections.get(selectionId) : undefined;
      if (!pane) {
        await ctx.answerCallbackQuery({ text: "Pane selection expired. Run /attach again.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Attaching and testing input..." });
      const session = await this.sessions.attach({ adapter: "pty", tmuxTarget: pane.target, label: `tmux ${pane.target}` });
      await ctx.reply(`Attached tmux pane ${pane.target}:\n${session.id}\n\nSending input test...`);
      await this.sendProbeResult(ctx.chat?.id, await this.sessions.probeTmuxSession(session.id));
    });

    this.bot.callbackQuery(/^probe:/, async (ctx) => {
      const [, action, sessionId] = String(ctx.callbackQuery.data).split(":");
      await ctx.answerCallbackQuery({ text: "Updating input test..." });
      if (action === "retry") {
        await this.sendProbeResult(ctx.chat?.id, await this.sessions.probeTmuxSession(sessionId));
        return;
      }
      if (action === "next") {
        await this.sendProbeResult(ctx.chat?.id, await this.sessions.tryNextTmuxStrategy(sessionId));
        return;
      }
      if (action === "key") {
        const strategy = String(ctx.callbackQuery.data).split(":")[3];
        if (!strategy) {
          await ctx.reply("Missing input strategy.");
          return;
        }
        await this.sendProbeResult(ctx.chat?.id, await this.sessions.probeTmuxSession(sessionId, strategy));
        return;
      }
      if (action === "ready") {
        this.sessions.markTmuxReady(sessionId);
        await ctx.reply("Marked as ready. Telegram messages will now be submitted to Codex with the selected key.");
        return;
      }
      if (action === "manual") {
        this.sessions.markTmuxManualSubmit(sessionId);
        await ctx.reply("Marked as paste-only. Telegram can paste text into the pane, but you must press submit locally.");
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
      await this.forwardUserText(ctx, text);
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
    const panes = await this.sessions.listTmuxPanes();
    if (panes.length === 0) {
      await ctx.reply("No tmux panes found. Start Codex in tmux, then run /attach again.");
      return;
    }

    const keyboard = new InlineKeyboard();
    panes.slice(0, 12).forEach((pane, index) => {
      const selectionId = Math.random().toString(36).slice(2, 10);
      this.paneSelections.set(selectionId, pane);
      keyboard.text(`${index + 1}. ${pane.target} ${pane.command}`, `pane:${selectionId}`).row();
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

  private async showTestInput(ctx: Context): Promise<void> {
    const session = this.sessions.getActiveSession();
    if (!session?.tmuxTarget) {
      await ctx.reply("Active session is not a tmux attachment. Use /attach first.");
      return;
    }

    await ctx.reply(formatTestInput(session), { reply_markup: testInputKeyboard(session.id) });
  }

  private async sendProbeResult(chatId: number | undefined, result: ProbeResult): Promise<void> {
    if (!chatId) return;
    await this.bot.api.sendMessage(chatId, formatProbeResult(result), {
      reply_markup: testInputKeyboard(result.sessionId)
    });
  }

  private async startProjectSession(ctx: Context, project: WorkspaceProject): Promise<void> {
    try {
      await this.ensureDirectory(project.path);
      const session = await this.sessions.newSession({ adapter: "appserver", cwd: project.path, label: project.name });
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

  private async forwardUserText(ctx: Context, text: string): Promise<void> {
    try {
      await this.sessions.sendToActive(text);
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
    await ctx.reply("Sent to Codex.");
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
      const active = this.sessions.getActiveSession();
      if (active?.id !== event.sessionId) return;
      this.bufferAgentMessage(event.sessionId, event.text, active);
      return;
    }

    if (event.type === "actionResolved") {
      await this.clearActionKeyboards(event.actionId);
      return;
    }

    if (event.type === "approvalRequested" || event.type === "questionAsked") {
      for (const chatId of this.allowedDeliveryChats()) {
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
      for (const chatId of this.allowedDeliveryChats()) {
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
      for (const chatId of this.allowedDeliveryChats()) {
        this.store.enqueueOutbox(`goal:${event.sessionId}:${event.goal.status}:${event.goal.updatedAt}`, chatId, {
          text: formatGoal(event.goal)
        });
      }
      void this.drainOutbox();
      return;
    }

    if (event.type === "rateLimitsChanged" && (event.recovered || event.limits.usedPercent >= this.config.rateLimitWarnPercent)) {
      const bucket = event.limits.usedPercent >= 100 ? 100 : event.limits.usedPercent >= 95 ? 95 : this.config.rateLimitWarnPercent;
      for (const chatId of this.allowedDeliveryChats()) {
        this.store.enqueueOutbox(`limits:${event.recovered ? "recovered" : bucket}:${event.limits.resetsAt ?? "unknown"}`, chatId, {
          text: `${event.recovered ? "Codex rate limits recovered" : "Codex rate-limit warning"}\n\n${formatLimits(event.limits)}`
        });
      }
      void this.drainOutbox();
      return;
    }

    if (event.type === "warning") {
      for (const chatId of this.allowedDeliveryChats()) {
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
    for (const chatId of this.allowedDeliveryChats()) {
      await this.bot.api.sendMessage(chatId, text);
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

function sessionsKeyboard(sessions: StoredSession[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  sessions.slice(0, 10).forEach((session, index) => {
    const action = session.status === "stopped" ? "use" : session.adapter === "appserver" ? "resume" : "use";
    keyboard
      .text(`${index + 1}. ${action === "resume" ? "Resume thread" : "Use"}`, `sess:${action}:${session.id}`)
      .text("Transcript", `sess:transcript:${session.id}`)
      .row();
    keyboard
      .text(session.paused ? "Resume input" : "Pause input", `sess:${session.paused ? "unpause" : "pause"}:${session.id}`)
      .text("Kill", `sess:kill:${session.id}`)
      .row();
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

function testInputKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Codex answered", `probe:ready:${sessionId}`)
    .row()
    .text("Test Enter", `probe:key:${sessionId}:enter`)
    .text("Test F12", `probe:key:${sessionId}:f12`)
    .row()
    .text("Retry test", `probe:retry:${sessionId}`)
    .text("Try next key", `probe:next:${sessionId}`)
    .row()
    .text("Paste only", `probe:manual:${sessionId}`);
}

function formatTestInput(session: StoredSession): string {
  return [
    "Input test status",
    "",
    `session: ${session.id}`,
    `target: ${session.tmuxTarget ?? "none"}`,
    `status: ${session.attachStatus ?? "unknown"}`,
    `submit: ${session.submitStrategy ?? "default"}`,
    session.lastProbe ? `last probe: ${session.lastProbe}` : undefined,
    session.lastProbeAt ? `last probe at: ${new Date(session.lastProbeAt).toISOString()}` : undefined,
    "",
    "Use Retry test to send a probe with the current key. Press Codex answered only if Codex actually replied to the probe in the tmux pane."
  ]
    .filter(Boolean)
    .join("\n");
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

function parseAdapterCommand(match: string | undefined): { adapter?: "appserver" | "pty"; rest: string } {
  const value = String(match ?? "").trim();
  if (value.startsWith("pty ")) return { adapter: "pty", rest: value.slice(4).trim() };
  if (value.startsWith("appserver ")) return { adapter: "appserver", rest: value.slice(10).trim() };
  if (value === "pty" || value === "appserver") return { adapter: value, rest: "" };
  return { rest: value };
}
