import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import { PolicyEngine } from "../security/policy.js";
import { Store } from "../store/store.js";
import type { StoredSession } from "../store/store.js";
import type { CodexEvent, ApprovalDecision } from "../types/events.js";
import type { CodexModelSummary, CodexThreadSummary, CollaborationModeKind } from "../types/control.js";
import { SessionManager } from "../runtime/session-manager.js";
import { listWorkspaceProjects, resolveWorkspacePath, type WorkspaceProject } from "../runtime/workspace.js";
import { appendAgentMessageChunk, formatAction, formatAgentMessage, formatLogs, formatSessions, truncateMiddle } from "./format.js";
import type { ProbeResult, TmuxPane } from "../adapters/pty-adapter.js";

export class TelegramGateway {
  private readonly bot: Bot;
  private readonly messageBuffers = new Map<string, { text: string; timer: NodeJS.Timeout }>();
  private readonly paneSelections = new Map<string, TmuxPane>();
  private readonly projectSelections = new Map<string, WorkspaceProject>();
  private readonly threadSelections = new Map<string, CodexThreadSummary>();
  private readonly modelSelections = new Map<string, CodexModelSummary>();
  private readonly answerSelections = new Map<string, { actionId: string; nonce: string; text: string }>();

  constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionManager,
    private readonly store: Store,
    private readonly policy: PolicyEngine,
    private readonly logger: Logger
  ) {
    this.bot = new Bot(config.botToken);
    this.bot.use(async (ctx, next) => {
      if (!this.policy.authorizeTelegramUser(ctx.from?.id, ctx.chat?.id)) {
        this.logger.warn({ userId: ctx.from?.id, chatId: ctx.chat?.id }, "rejected unauthorized Telegram update");
        return;
      }
      await next();
    });
    this.bot.catch((error) => {
      this.logger.error({ error }, "Telegram bot middleware failed");
    });
    this.registerHandlers();
  }

  async start(): Promise<void> {
    void this.forwardCodexEvents();
    await this.bot.api.setMyCommands([
      { command: "status", description: "Show active Codex session" },
      { command: "sessions", description: "List local sessions" },
      { command: "new", description: "Start a new Codex session" },
      { command: "resume", description: "Resume a previous Codex thread" },
      { command: "threads", description: "List previous app-server threads" },
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

  private registerHandlers(): void {
    this.bot.command("help", async (ctx) => {
      await ctx.reply(
        [
          "/status - active session",
          "/sessions - list and control sessions",
          "/new - pick a workspace project",
          "/new <project-or-path> - start app-server session in a workspace folder",
          "/resume - list previous app-server threads",
          "/resume <threadId|localSessionId> - resume a previous session",
          "/threads - list previous app-server threads",
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
          "/transcript - export full active transcript",
          "/pause and /unpause - toggle forwarding",
          "/kill - interrupt active session",
          "Plain text is forwarded to the active Codex session."
        ].join("\n")
      );
    });

    this.bot.command("status", async (ctx) => {
      const active = this.sessions.getActiveSession();
      await ctx.reply(active ? formatSessions([active]) : "No active Codex session.");
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
      const target = String(ctx.match ?? "").trim();
      if (!target) {
        await this.showThreadPicker(ctx);
        return;
      }
      const local = this.store.getSession(target);
      const session = local ? await this.sessions.resumeSession(local.id) : await this.sessions.resumeThread(target);
      await ctx.reply(`Resumed app-server session:\n${session.label}\n${session.id}`);
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

    this.bot.callbackQuery(/^act:/, async (ctx) => {
      const [, actionId, nonce, decision] = String(ctx.callbackQuery.data).split(":");
      const action = actionId ? this.store.getPendingAction(actionId) : undefined;
      if (!action || !nonce || !decision) {
        await ctx.answerCallbackQuery({ text: "Unknown action.", show_alert: true });
        return;
      }
      try {
        this.policy.validateDecision(action, { actionId: action.id, decision: decision as ApprovalDecision }, nonce);
        await this.sessions.respondAction({ actionId: action.id, decision: decision as ApprovalDecision });
        await ctx.editMessageReplyMarkup();
        await ctx.answerCallbackQuery({ text: "Sent to Codex." });
      } catch (error) {
        await ctx.answerCallbackQuery({ text: error instanceof Error ? error.message : "Rejected.", show_alert: true });
      }
    });

    this.bot.callbackQuery(/^answer:/, async (ctx) => {
      const [, selectionId] = String(ctx.callbackQuery.data).split(":");
      const selection = selectionId ? this.answerSelections.get(selectionId) : undefined;
      if (!selection) {
        await ctx.answerCallbackQuery({ text: "Answer selection expired.", show_alert: true });
        return;
      }
      const action = this.store.getPendingAction(selection.actionId);
      if (!action) {
        await ctx.answerCallbackQuery({ text: "Question is no longer pending.", show_alert: true });
        return;
      }
      try {
        this.policy.validateDecision(action, { actionId: action.id, decision: "accept", text: selection.text }, selection.nonce);
        await this.sessions.respondAction({ actionId: action.id, decision: "accept", text: selection.text });
        await ctx.editMessageReplyMarkup();
        await ctx.answerCallbackQuery({ text: "Sent to Codex." });
      } catch (error) {
        await ctx.answerCallbackQuery({ text: error instanceof Error ? error.message : "Rejected.", show_alert: true });
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
      await ctx.reply(`Resumed app-server thread:\n${session.label}\n${session.id}`);
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

    this.bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;
      if (text.startsWith("/")) return;
      await this.forwardUserText(ctx, text);
    });
  }

  private async showWorkspacePicker(ctx: Context): Promise<void> {
    const [text, options] = await this.workspacePickerMessage();
    await ctx.reply(text, options);
  }

  private async sendStartupPicker(): Promise<void> {
    const sessions = this.sessions.listSessions().filter((session) => session.status !== "stopped");
    for (const chatId of this.allowedDeliveryChats()) {
      try {
        if (sessions.length > 0) {
          await this.bot.api.sendMessage(chatId, `Recoverable sessions:\n\n${formatSessions(sessions)}`, {
            reply_markup: sessionsKeyboard(sessions)
          });
        }
        const [text, options] = await this.workspacePickerMessage();
        await this.bot.api.sendMessage(chatId, text, options);
      } catch (error) {
        this.logger.warn({ error, chatId }, "failed to send startup picker");
      }
    }
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
      await ctx.reply("No previous app-server threads found.");
      return;
    }

    const keyboard = new InlineKeyboard();
    this.threadSelections.clear();
    threads.forEach((thread, index) => {
      const selectionId = Math.random().toString(36).slice(2, 10);
      this.threadSelections.set(selectionId, thread);
      keyboard.text(`${index + 1}. Resume`, `thread:${selectionId}`).row();
    });

    await ctx.reply(formatThreads(threads), { reply_markup: keyboard });
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
    await ctx.reply("Sent to Codex.");
  }

  private async forwardCodexEvents(): Promise<void> {
    for await (const event of this.sessions.events()) {
      await this.handleCodexEvent(event);
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

    if (event.type === "approvalRequested" || event.type === "questionAsked") {
      const keyboard = this.actionKeyboard(event.action);
      for (const chatId of this.allowedDeliveryChats()) {
        const sent = await this.bot.api.sendMessage(chatId, formatAction(event.action), {
          parse_mode: "MarkdownV2",
          reply_markup: keyboard
        });
        this.store.setTelegramMessage(event.action.id, chatId, sent.message_id);
      }
      return;
    }

    if (event.type === "taskCompleted" || event.type === "error" || event.type === "blocked") {
      const text =
        event.type === "taskCompleted"
          ? `Codex task ${event.status}: ${event.summary}`
          : event.type === "error"
            ? `Codex error: ${event.message}`
            : `Codex blocked: ${event.reason}`;
      for (const chatId of this.allowedDeliveryChats()) {
        await this.bot.api.sendMessage(chatId, truncateMiddle(text));
      }
    }
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

  private actionKeyboard(action: { id: string; nonce: string; kind: string; payload?: unknown }): InlineKeyboard {
    if (action.kind === "question") {
      const keyboard = new InlineKeyboard();
      const choices = extractQuestionChoices(action.payload);
      choices.slice(0, 8).forEach((choice) => {
        const selectionId = Math.random().toString(36).slice(2, 10);
        this.answerSelections.set(selectionId, { actionId: action.id, nonce: action.nonce, text: choice });
        keyboard.text(choice.slice(0, 48), `answer:${selectionId}`).row();
      });
      keyboard.text("Reply in chat", `act:${action.id}:${action.nonce}:cancel`);
      return keyboard;
    }
    return new InlineKeyboard()
      .text("Approve", `act:${action.id}:${action.nonce}:accept`)
      .text("Approve for session", `act:${action.id}:${action.nonce}:acceptForSession`)
      .row()
      .text("Deny", `act:${action.id}:${action.nonce}:decline`);
  }

  private allowedDeliveryChats(): number[] {
    if (this.config.allowedChatIds.size > 0) return [...this.config.allowedChatIds];
    return [...this.config.allowedUserIds];
  }
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

function formatThreads(threads: CodexThreadSummary[]): string {
  return [
    "Previous app-server threads",
    "",
    ...threads.map((thread, index) => {
      const title = thread.name || thread.preview || thread.id;
      const updated = thread.updatedAt ? new Date(thread.updatedAt * 1000).toISOString() : "unknown";
      const cwd = thread.cwd ? `\n${thread.cwd}` : "";
      return `${index + 1}. ${title.slice(0, 120)}\n${thread.id}\nupdated: ${updated}${cwd}`;
    }),
    "",
    "Use /resume <threadId> to resume one directly."
  ].join("\n\n");
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

function extractQuestionChoices(payload: unknown): string[] {
  const record = asRecord(payload);
  const params = asRecord(record.params);
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const choices: string[] = [];
  for (const question of questions) {
    const item = asRecord(question);
    const rawChoices = Array.isArray(item.options)
      ? item.options
      : Array.isArray(item.choices)
        ? item.choices
        : Array.isArray(item.answers)
          ? item.answers
          : [];
    for (const rawChoice of rawChoices) {
      if (typeof rawChoice === "string") {
        choices.push(rawChoice);
      } else {
        const choice = asRecord(rawChoice);
        const label = choice.label ?? choice.value ?? choice.text ?? choice.title;
        if (typeof label === "string") choices.push(label);
      }
    }
  }
  return [...new Set(choices)];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
