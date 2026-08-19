import { InlineKeyboard, InputFile, type Context } from "grammy";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import { PolicyEngine } from "../security/policy.js";
import { Store } from "../store/store.js";
import type { CallbackToken, StartupRecovery, StoredSession } from "../store/store.js";
import type { CodexEvent, SessionRef } from "../types/events.js";
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
import { withTemporaryTextExport } from "../runtime/temporary-export.js";
import { sanitizeDiagnosticText } from "../runtime/diagnostics.js";
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
import { LegacyTmuxBridge, type LegacyCaptureResult, type ProbeResult } from "../legacy/legacy-tmux-bridge.js";
import type { LegacyTmuxAttachment } from "../types/legacy-tmux.js";
import { formatDoctorReport, runDoctor } from "../runtime/doctor.js";
import { parseResumeCommand } from "./resume-command.js";
import { PendingInteractionManager, type InteractionView } from "./pending-interaction.js";
import { createId } from "../utils/ids.js";
import { TelegramRouting } from "./routing.js";
import { assertCallbackResource, TelegramCallbackController } from "./callback-controller.js";
import { TelegramPickerController } from "./picker-controller.js";
import type { RuntimeHealth, RuntimeHealthReporter } from "../runtime/health.js";
import { noopRuntimeHealth } from "../runtime/health.js";
import type { SupervisedSubsystem } from "../runtime/supervisor.js";
import { TelegramBotRuntime, type TelegramCommandDefinition, type TelegramRuntime } from "./bot-runtime.js";

const INTERACTION_CONTROL_OPERATIONS = [
  "panel:refresh", "panel:status", "panel:usage", "panel:new", "panel:resume", "panel:models",
  "panel:plan", "panel:default", "panel:pause", "panel:unpause", "panel:transcript",
  "session:use", "session:resume", "session:transcript", "session:detach", "session:archive",
  "session:forget", "session:kill", "session:confirm-kill", "session:confirm-archive",
  "session:confirm-forget"
] as const;

const AGENT_MESSAGE_FLUSH_DELAY_MS = 1_200;
const AGENT_MESSAGE_MAX_ATTEMPTS = 3;

interface AgentMessageDelivery {
  text: string;
  attempts: number;
}

interface AgentMessageBuffer {
  deliveries: Map<number, AgentMessageDelivery>;
  timer?: NodeJS.Timeout;
  flushPromise?: Promise<void>;
}

export class TelegramGateway {
  private readonly runtime: TelegramRuntime;
  private readonly bot: TelegramRuntime["bot"];
  private readonly runtimeId = createId("runtime");
  private readonly messageBuffers = new Map<string, AgentMessageBuffer>();
  private readonly interactions: PendingInteractionManager;
  private readonly routing: TelegramRouting;
  private readonly callbacks: TelegramCallbackController;
  private readonly pickers: TelegramPickerController;
  private eventController?: AbortController;
  private eventPromise?: Promise<void>;
  private outboxController?: AbortController;
  private outboxPromise?: Promise<void>;
  private actionSweepController?: AbortController;
  private actionSweepPromise?: Promise<void>;
  private pollingStopPromise?: Promise<void>;
  private drainingOutbox = false;
  private nextMaintenanceAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionManager,
    private readonly legacyTmux: LegacyTmuxBridge,
    private readonly store: Store,
    policy: PolicyEngine,
    private readonly logger: Logger,
    private readonly health: RuntimeHealthReporter = noopRuntimeHealth,
    runtime?: TelegramRuntime
  ) {
    this.runtime = runtime ?? new TelegramBotRuntime(config.botToken, policy, health, logger);
    this.bot = this.runtime.bot;
    this.interactions = new PendingInteractionManager(store, config.allowSessionGrants);
    this.routing = new TelegramRouting(store, sessions);
    this.callbacks = new TelegramCallbackController(store);
    this.pickers = new TelegramPickerController(config.workspaceRoot, store, sessions, this.callbacks);
    this.registerHandlers();
  }

  async startPolling(): Promise<void> {
    const commands: TelegramCommandDefinition[] = [
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
      { command: "pause", description: "Pause Telegram input forwarding" },
      { command: "unpause", description: "Resume Telegram input forwarding" },
      { command: "kill", description: "Interrupt active turn" },
      { command: "help", description: "Show help" }
    ];
    await this.sendStartupPicker();
    await this.runtime.start(commands);
  }

  runtimeSubsystems(): SupervisedSubsystem[] {
    return [
      {
        name: "telegram-polling",
        start: () => this.startPolling(),
        wait: () => this.runtime.wait(),
        stop: () => this.stopPolling()
      },
      {
        name: "event-forwarder",
        start: () => this.startEventForwarder(),
        wait: () => this.eventPromise ?? Promise.reject(new Error("Event forwarder was not started.")),
        stop: async () => {
          this.eventController?.abort();
          await this.eventPromise;
        }
      },
      {
        name: "outbox-worker",
        start: () => this.startOutboxWorker(),
        wait: () => this.outboxPromise ?? Promise.reject(new Error("Outbox worker was not started.")),
        stop: async () => {
          this.outboxController?.abort();
          await this.outboxPromise;
        }
      },
      {
        name: "action-sweeper",
        start: () => this.startActionSweeper(),
        wait: () => this.actionSweepPromise ?? Promise.reject(new Error("Action sweeper was not started.")),
        stop: async () => {
          this.actionSweepController?.abort();
          await this.actionSweepPromise;
        }
      }
    ];
  }

  async stop(): Promise<void> {
    this.actionSweepController?.abort();
    this.outboxController?.abort();
    this.eventController?.abort();
    await this.stopPolling();
  }

  private startEventForwarder(): void {
    this.eventController = new AbortController();
    this.eventPromise = this.forwardCodexEvents(this.eventController.signal);
  }

  private startOutboxWorker(): void {
    this.outboxController = new AbortController();
    this.outboxPromise = this.runOutboxWorker(this.outboxController.signal);
  }

  private startActionSweeper(): void {
    this.actionSweepController = new AbortController();
    this.actionSweepPromise = this.runActionSweeper(this.actionSweepController.signal);
  }

  private stopPolling(): Promise<void> {
    if (this.pollingStopPromise) return this.pollingStopPromise;
    this.pollingStopPromise = (async () => {
      for (const buffer of this.messageBuffers.values()) clearTimeout(buffer.timer);
      for (const sessionId of [...this.messageBuffers.keys()]) {
        try {
          await this.flushAgentMessage(sessionId);
        } catch (error) {
          this.health.deliveryFailure(error);
          this.logger.warn({ error, sessionId }, "could not flush buffered agent message during shutdown");
        }
      }
      for (const [sessionId, buffer] of this.messageBuffers) {
        if (buffer.timer) clearTimeout(buffer.timer);
        this.logger.warn(
          { sessionId, chatCount: buffer.deliveries.size },
          "dropping buffered Telegram agent messages during shutdown"
        );
      }
      this.messageBuffers.clear();
      try {
        await this.drainOutbox();
      } catch (error) {
        this.health.deliveryFailure(error);
        this.logger.warn({ error }, "could not drain Telegram outbox during shutdown");
      }
      this.runtime.stop();
    })();
    return this.pollingStopPromise;
  }

  private async runOutboxWorker(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.drainOutbox();
      this.health.heartbeat("outbox-worker");
      await waitForWorkerTick(signal, 1_000);
    }
  }

  private async runActionSweeper(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.sessions.expirePendingActions();
      if (Date.now() >= this.nextMaintenanceAt) {
        this.performMaintenance(Date.now());
      }
      this.health.heartbeat("action-sweeper");
      await waitForWorkerTick(signal, 1_000);
    }
  }

  private performMaintenance(now: number): void {
    const days = this.config.transcriptRetentionDays;
    this.store.maintain({
      now,
      ...(days === undefined ? {} : { transcriptRetentionMs: days * 24 * 60 * 60 * 1000 })
    });
    this.store.checkpoint("PASSIVE");
    this.nextMaintenanceAt = now + 60 * 60 * 1000;
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
          "/tmux capture <attachmentId> - inspect only newly observed pane output",
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
      await ctx.reply(formatSessions(sessions), { reply_markup: this.sessionsKeyboard(ctx.chat.id, ctx.from!.id, sessions) });
    });

    this.bot.command("new", async (ctx) => {
      const rest = parseAppServerCommand(ctx.match);
      if (!rest) {
        await this.showWorkspacePicker(ctx);
        return;
      }
      const project = await resolveWorkspacePath(this.config.workspaceRoot, rest || String(ctx.match ?? "").trim());
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
      const keyboard = this.confirmationKeyboard(ctx.chat.id, ctx.from!.id, "session:confirm-archive", active, "Confirm archive");
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
      const keyboard = this.confirmationKeyboard(ctx.chat.id, ctx.from!.id, "session:confirm-forget", this.store.getSession(sessionId)!, "Confirm forget");
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
      const routed = await this.routing.sendDirect(ctx.chat.id, direct[1]!, direct[2]!);
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
      if (action === "capture" && target) {
        await ctx.reply(formatLegacyCapture(await this.legacyTmux.capture(target, ctx.chat.id)));
        return;
      }
      if (action === "interrupt" && target) {
        await this.legacyTmux.interrupt(target, ctx.chat.id);
        await ctx.reply("Sent Ctrl-C to the externally managed tmux pane. The pane/process was not killed or taken over by tele-codex.");
        return;
      }
      const paneTarget = action === "attach" ? target : input;
      if (!paneTarget) {
        await ctx.reply("Usage: /tmux attach <target> | send <attachmentId> <text> | capture <attachmentId> | test <attachmentId> | interrupt <attachmentId>");
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
        const view = this.interactions.actionView(action, ctx.chat.id, ctx.from!.id);
        await ctx.reply(`${formatAction(action)}\n\n${escapeMd(view.text)}`, {
          parse_mode: "MarkdownV2",
          reply_markup: interactionKeyboard(view)
        });
      }
    });

    this.bot.command("health", async (ctx) => {
      const outbox = this.store.outboxCounts();
      const active = this.sessions.getActiveSession();
      const snapshot = "snapshot" in this.health
        ? (this.health as RuntimeHealth).snapshot()
        : undefined;
      await ctx.reply(formatRuntimeHealth(snapshot, {
        session: active ? `${active.status} (${active.label})` : "none active",
        pending: this.store.listPendingActions().length,
        queued: outbox.pending,
        failed: outbox.failed,
        storage: this.store.diagnostics()
      }));
    });

    this.bot.command("retrydelivery", async (ctx) => {
      const count = this.store.retryFailedOutbox();
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
        await withTemporaryTextExport("tele-codex-diff-", "codex-turn.patch", diff,
          (path) => ctx.replyWithDocument(new InputFile(path, "codex-turn.patch")));
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
        const token = this.pickers.processToken({ chatId: ctx.chat.id, userId: ctx.from!.id }, session, process);
        keyboard.text(`Stop ${index + 1}`, `proc:${token}`).row();
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
      const keyboard = this.confirmationKeyboard(ctx.chat.id, ctx.from!.id, "session:confirm-kill", active, "Confirm kill");
      await ctx.reply(`Interrupt active session?\n${active.id}`, { reply_markup: keyboard });
    });

    this.bot.callbackQuery(/^cb:/, async (ctx) => {
      const token = String(ctx.callbackQuery.data).slice(3);
      const userId = ctx.from.id;
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.answerCallbackQuery({ text: "This interaction is not attached to a supported chat.", show_alert: true });
        return;
      }
      try {
        const result = await this.interactions.handleCallback(token, { chatId, userId }, async (decision) => {
          await this.sessions.respondAction(decision);
        });
        if (result.kind === "notice") {
          await ctx.answerCallbackQuery({ text: result.text, show_alert: true });
          return;
        }
        if (result.kind === "submit") {
          await ctx.answerCallbackQuery();
          await this.finalizeActionMessages(result.decision.actionId, result.text);
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
      if (!chatId) {
        await ctx.answerCallbackQuery({ text: "This thread picker is not attached to a supported chat.", show_alert: true });
        return;
      }
      try {
        const session = await this.routing.selectPicker(token, chatId, ctx.from.id);
        await ctx.answerCallbackQuery({ text: "Thread selected." });
        await ctx.reply(`Your next message will be sent once to:\n${session.label}\n${session.cwd ?? session.id}\n\nThis compose selection expires in 5 minutes.`);
      } catch (error) {
        await ctx.answerCallbackQuery({ text: error instanceof Error ? error.message : "Could not select thread.", show_alert: true });
      }
    });

    this.bot.callbackQuery(/^ctl:/, async (ctx) => {
      const token = String(ctx.callbackQuery.data).slice(4);
      try {
        await this.callbacks.execute(
          token,
          { chatId: ctx.chat!.id, userId: ctx.from.id },
          INTERACTION_CONTROL_OPERATIONS,
          (callback) => this.applyInteractionControl(ctx, callback)
        );
      } catch (error) {
        await ctx.answerCallbackQuery({ text: callbackError(error, "Control failed. Run the command again."), show_alert: true });
      }
    });

    this.bot.callbackQuery(/^proj:/, async (ctx) => {
      try {
        const token = String(ctx.callbackQuery.data).slice(5);
        const project = await this.pickers.selectProject(token, { chatId: ctx.chat!.id, userId: ctx.from.id });
        await ctx.answerCallbackQuery({ text: "Starting Codex..." });
        await this.startProjectSession(ctx, project);
      } catch (error) {
        await ctx.answerCallbackQuery({ text: callbackError(error, "Project selection failed."), show_alert: true });
      }
    });

    this.bot.callbackQuery(/^thread:/, async (ctx) => {
      try {
        const token = String(ctx.callbackQuery.data).slice(7);
        const session = await this.pickers.selectThread(token, { chatId: ctx.chat!.id, userId: ctx.from.id });
        await ctx.answerCallbackQuery({ text: "Thread resumed." });
        await ctx.reply(`Resumed Codex session:\n${session.label}\n${session.id}`);
      } catch (error) {
        await ctx.answerCallbackQuery({ text: callbackError(error, "Thread selection failed."), show_alert: true });
      }
    });

    this.bot.callbackQuery(/^model:/, async (ctx) => {
      try {
        const token = String(ctx.callbackQuery.data).slice(6);
        const modelId = await this.pickers.selectModel(token, { chatId: ctx.chat!.id, userId: ctx.from.id });
        await ctx.answerCallbackQuery({ text: "Model changed." });
        await ctx.reply(`Model changed for subsequent turns:\n${modelId}`);
      } catch (error) {
        await ctx.answerCallbackQuery({ text: callbackError(error, "Model selection failed."), show_alert: true });
      }
    });

    this.bot.callbackQuery(/^legacy:/, async (ctx) => {
      const token = String(ctx.callbackQuery.data).slice(7);
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.answerCallbackQuery({ text: "This legacy control is not attached to a supported chat.", show_alert: true });
        return;
      }
      let answered = false;
      try {
        await this.callbacks.execute(token, { chatId, userId: ctx.from.id }, ["legacy-tmux-attach", "legacy-tmux-probe"], async (callback) => {
          const payload = callback.payload as { target?: string; attachmentId?: string; action?: string; strategy?: string; expectedVersion?: number };
          if (callback.operation === "legacy-tmux-attach" && payload.target) {
            assertCallbackResource(callback, "legacy-tmux-target", payload.target);
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
          if (typeof payload.expectedVersion !== "number") throw new Error("Invalid legacy tmux control version.");
          assertCallbackResource(callback, "legacy-tmux-attachment", payload.attachmentId, payload.expectedVersion);
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
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Legacy tmux action failed.";
        if (answered) await ctx.reply(detail);
        else await ctx.answerCallbackQuery({ text: detail, show_alert: true });
      }
    });

    this.bot.callbackQuery(/^proc:/, async (ctx) => {
      const token = String(ctx.callbackQuery.data).slice(5);
      try {
        const selected = await this.pickers.selectProcess(token, { chatId: ctx.chat!.id, userId: ctx.from.id });
        const keyboard = new InlineKeyboard().text("Confirm stop", `proc-confirm:${selected.confirmationToken}`);
        await ctx.answerCallbackQuery();
        await ctx.reply(`Terminate this background process?\n${selected.selection.command}`, { reply_markup: keyboard });
      } catch (error) {
        await ctx.answerCallbackQuery({ text: callbackError(error, "Process selection failed."), show_alert: true });
      }
    });

    this.bot.callbackQuery(/^proc-confirm:/, async (ctx) => {
      const token = String(ctx.callbackQuery.data).slice(13);
      try {
        const terminated = await this.pickers.terminateProcess(token, { chatId: ctx.chat!.id, userId: ctx.from.id });
        await ctx.answerCallbackQuery({ text: terminated ? "Terminated." : "Process was already gone." });
        await ctx.editMessageText(terminated ? "Background process terminated." : "Background process was already gone.");
      } catch (error) {
        await ctx.answerCallbackQuery({ text: callbackError(error, "Process termination failed."), show_alert: true });
      }
    });

    this.bot.on("callback_query:data", async (ctx) => {
      await ctx.answerCallbackQuery({
        text: "This control is unknown or no longer supported. Run the command again.",
        show_alert: true
      });
    });

    this.bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;
      if (text.startsWith("/")) {
        await ctx.reply("Unknown command. Run /help to see supported commands.");
        return;
      }
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

  private async applyInteractionControl(ctx: Context, callback: CallbackToken): Promise<void> {
    const operation = callback.operation;
    if (operation.startsWith("panel:")) {
      if (callback.resourceKind !== "panel" && callback.resourceKind !== "session") {
        throw new Error("This panel control has an invalid target. Run /panel again.");
      }
      if (callback.resourceKind === "panel" && callback.actionId !== "main") {
        throw new Error("This panel control has an invalid target. Run /panel again.");
      }
    } else if (callback.resourceKind !== "session") {
      throw new Error("This session control has an invalid target. Run /sessions again.");
    }
    const session = callback.resourceKind === "session" ? this.sessionForControl(callback) : undefined;

    if (operation === "panel:refresh") {
      await ctx.answerCallbackQuery({ text: "Refreshed." });
      await this.editOrReplyPanel(ctx);
    } else if (operation === "panel:status") {
      const active = this.sessions.getActiveSession();
      await ctx.answerCallbackQuery();
      await ctx.reply(active ? this.statusText(active) : "No active session.");
    } else if (operation === "panel:usage") {
      await ctx.answerCallbackQuery();
      await ctx.reply(session ? formatUsage(this.store.getTokenUsage(session.id)) : "No active session.");
    } else if (operation === "panel:new") {
      await ctx.answerCallbackQuery({ text: "Choose a project." });
      await this.showWorkspacePicker(ctx);
    } else if (operation === "panel:resume") {
      await ctx.answerCallbackQuery({ text: "Choose a thread." });
      await this.showThreadPicker(ctx);
    } else if (operation === "panel:models") {
      await ctx.answerCallbackQuery({ text: "Choose a model." });
      await this.showModelPicker(ctx);
    } else if (operation === "panel:plan" || operation === "panel:default") {
      await this.sessions.setMode(operation === "panel:plan" ? "plan" : "default");
      await ctx.answerCallbackQuery({ text: operation === "panel:plan" ? "Plan mode enabled." : "Default mode enabled." });
      await this.editOrReplyPanel(ctx);
    } else if (operation === "panel:pause" || operation === "panel:unpause") {
      if (!session) throw new Error("The panel session no longer exists. Run /panel again.");
      if (operation === "panel:pause") this.sessions.pause(session.id);
      else this.sessions.resume(session.id);
      await ctx.answerCallbackQuery({ text: operation === "panel:pause" ? "Paused." : "Input resumed." });
      await this.editOrReplyPanel(ctx);
    } else if (operation === "panel:transcript") {
      await ctx.answerCallbackQuery({ text: "Exporting transcript." });
      await this.sendTranscript(ctx, session?.id);
    } else if (operation === "session:use") {
      const selected = await this.routing.setSticky(ctx.chat!.id, ctx.from!.id, session!.id);
      await ctx.answerCallbackQuery({ text: "Sticky route updated." });
      await ctx.reply(`Sticky route for this chat and user:\n${selected.label}\n${selected.id}`);
    } else if (operation === "session:resume") {
      const resumed = await this.sessions.resumeSession(session!.id);
      await ctx.answerCallbackQuery({ text: "Session resumed." });
      await ctx.reply(`Resumed session:\n${resumed.label}\n${resumed.id}`);
    } else if (operation === "session:transcript") {
      await ctx.answerCallbackQuery({ text: "Exporting transcript." });
      await this.sendTranscript(ctx, session!.id);
    } else if (operation === "session:detach") {
      await this.sessions.detach(session!.id);
      await ctx.answerCallbackQuery({ text: "Detached." });
      await ctx.editMessageText(`Detached thread:\n${session!.id}\nUse /sessions to resume it.`);
    } else if (["session:archive", "session:forget", "session:kill"].includes(operation)) {
      const action = operation.slice("session:".length);
      const label = action === "archive" ? "archive" : action === "forget" ? "forget" : "kill";
      const keyboard = this.confirmationKeyboard(
        ctx.chat!.id,
        ctx.from!.id,
        `session:confirm-${label}`,
        session!,
        `Confirm ${label}`
      );
      await ctx.answerCallbackQuery({ text: `Confirm ${label}.` });
      const detail = label === "forget" ? "Forget local metadata? Codex history is not deleted." : label === "archive" ? "Archive thread?" : "Interrupt session?";
      await ctx.reply(`${detail}\n${session!.id}`, { reply_markup: keyboard });
    } else if (operation === "session:confirm-kill") {
      await this.sessions.kill(session!.id);
      await ctx.answerCallbackQuery({ text: "Interrupted." });
      await ctx.editMessageText(`Interrupted session:\n${session!.id}`);
    } else if (operation === "session:confirm-archive") {
      await this.sessions.archive(session!.id);
      await ctx.answerCallbackQuery({ text: "Archived." });
      await ctx.editMessageText(`Archived session:\n${session!.id}`);
    } else if (operation === "session:confirm-forget") {
      await this.sessions.forget(session!.id);
      await ctx.answerCallbackQuery({ text: "Local metadata forgotten." });
      await ctx.editMessageText(`Forgot local thread metadata:\n${session!.id}`);
    } else {
      throw new Error("This interaction action is no longer supported. Run the command again.");
    }
  }

  private sessionForControl(callback: CallbackToken): StoredSession {
    const session = this.store.getSession(callback.actionId);
    const currentVersion = session ? this.store.getSessionResourceVersion(session.id) : undefined;
    if (!session || callback.expectedVersion === undefined || currentVersion !== callback.expectedVersion) {
      throw new Error("This session changed or no longer exists. Run the command again.");
    }
    return session;
  }

  private confirmationKeyboard(
    chatId: number,
    userId: number,
    operation: string,
    session: StoredSession,
    label: string
  ): InlineKeyboard {
    return new InlineKeyboard().text(label, this.sessionControl(chatId, userId, operation, session));
  }

  private sessionControl(chatId: number, userId: number, operation: string, session: StoredSession): string {
    const expectedVersion = this.store.getSessionResourceVersion(session.id);
    if (expectedVersion === undefined) throw new Error("The selected session no longer exists.");
    const token = this.callbacks.issue({
      chatId,
      userId,
      actionId: session.id,
      resourceKind: "session",
      expectedVersion,
      operation,
      payload: {}
    });
    return `ctl:${token}`;
  }

  private panelControl(chatId: number, userId: number, operation: string, session?: StoredSession): string {
    if (session) return this.sessionControl(chatId, userId, operation, session);
    const token = this.callbacks.issue({
      chatId,
      userId,
      actionId: "main",
      resourceKind: "panel",
      operation,
      payload: {}
    });
    return `ctl:${token}`;
  }

  private panelKeyboard(chatId: number, userId: number, session?: StoredSession): InlineKeyboard {
    const keyboard = new InlineKeyboard()
      .text("Refresh", this.panelControl(chatId, userId, "panel:refresh"))
      .text("Status", this.panelControl(chatId, userId, "panel:status"))
      .text("Usage", this.panelControl(chatId, userId, "panel:usage", session))
      .row()
      .text("New", this.panelControl(chatId, userId, "panel:new"))
      .text("Resume", this.panelControl(chatId, userId, "panel:resume"))
      .text("Model", this.panelControl(chatId, userId, "panel:models", session))
      .row()
      .text("Plan", this.panelControl(chatId, userId, "panel:plan", session))
      .text("Default", this.panelControl(chatId, userId, "panel:default", session))
      .row();
    if (session) {
      keyboard
        .text(session.paused ? "Resume input" : "Pause input", this.panelControl(chatId, userId, `panel:${session.paused ? "unpause" : "pause"}`, session))
        .text("Transcript", this.panelControl(chatId, userId, "panel:transcript", session))
        .row();
    }
    return keyboard;
  }

  private sessionsKeyboard(chatId: number, userId: number, sessions: StoredSession[]): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    sessions.slice(0, 10).forEach((session, index) => {
      const resumable = session.status !== "archived";
      const usable = !session.paused && ["attached", "idle", "active", "blocked"].includes(session.status);
      const action = usable ? "use" : resumable ? "resume" : undefined;
      if (action) keyboard.text(`${index + 1}. ${action === "resume" ? "Resume thread" : "Use"}`, this.sessionControl(chatId, userId, `session:${action}`, session));
      keyboard.text("Transcript", this.sessionControl(chatId, userId, "session:transcript", session)).row();
      if (usable) {
        keyboard
          .text("Detach", this.sessionControl(chatId, userId, "session:detach", session))
          .text("Archive", this.sessionControl(chatId, userId, "session:archive", session))
          .row();
      }
      keyboard.text("Forget local", this.sessionControl(chatId, userId, "session:forget", session)).row();
    });
    return keyboard;
  }

  private async showWorkspacePicker(ctx: Context): Promise<void> {
    const [text, options] = await this.workspacePickerMessage(ctx.chat!.id, ctx.from!.id);
    await ctx.reply(text, options);
  }

  private async showPanel(ctx: Context): Promise<void> {
    const active = this.sessions.getActiveSession();
    await ctx.reply(active ? this.panelText(active) : "No active Codex session.", {
      reply_markup: this.panelKeyboard(ctx.chat!.id, ctx.from!.id, active)
    });
  }

  private async editOrReplyPanel(ctx: Context): Promise<void> {
    const active = this.sessions.getActiveSession();
    const text = active ? this.panelText(active) : "No active Codex session.";
    try {
      await ctx.editMessageText(text, { reply_markup: this.panelKeyboard(ctx.chat!.id, ctx.from!.id, active) });
    } catch {
      await ctx.reply(text, { reply_markup: this.panelKeyboard(ctx.chat!.id, ctx.from!.id, active) });
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
    const recovery = this.store.getStartupRecovery();
    await Promise.all((recovery?.orphanedActionIds ?? []).map((actionId) => this.finalizeActionMessages(
      actionId,
      "This request was invalidated when tele-codex restarted. Resume the thread and retry the original command."
    )));
    const deliveryChats = this.allowedDeliveryChats();
    if (recovery) {
      this.store.queueStartupRecovery(recovery.id, deliveryChats.map((chatId) => {
        const keyboard = sessions.length > 0
          ? this.sessionsKeyboard(chatId, this.config.controllerUserId, sessions) as unknown as { inline_keyboard: unknown[][] }
          : undefined;
        return {
          chatId,
          payload: {
            text: formatStartupRecovery(recovery, sessions),
            ...(keyboard ? { keyboard: keyboard.inline_keyboard } : {})
          }
        };
      }));
    }
    const outstandingRecovery = this.store.hasOutstandingStartupRecovery();
    for (const chatId of deliveryChats) {
      try {
        if (!recovery && !outstandingRecovery && sessions.length > 0) {
          const keyboard = this.sessionsKeyboard(chatId, this.config.controllerUserId, sessions) as unknown as { inline_keyboard: unknown[][] };
          this.store.enqueueOutbox(`startup-recovery:${this.runtimeId}`, chatId, {
            text: `tele-codex restarted. Threads are not resumed automatically.\n${lastActiveId ? `Last active: ${lastActiveId}\n` : ""}\nRecoverable sessions:\n\n${formatSessions(sessions)}`,
            keyboard: keyboard.inline_keyboard
          });
        }
        const projects = await listWorkspaceProjects(this.config.workspaceRoot);
        await this.bot.api.sendMessage(chatId, `${workspacePickerText(projects, this.config.workspaceRoot)}\n\nRun /new to open controls scoped to you.`);
        this.health.deliverySuccess();
      } catch (error) {
        this.health.deliveryFailure(error);
        this.logger.warn({ error, chatId }, "failed to send startup picker");
      }
    }
  }

  private async workspacePickerMessage(chatId: number, userId: number): Promise<[string, { reply_markup: InlineKeyboard }]> {
    const projects = await listWorkspaceProjects(this.config.workspaceRoot);
    const keyboard = new InlineKeyboard();
    projects.forEach((project, index) => {
      const token = this.pickers.projectToken({ chatId, userId }, project);
      keyboard.text(`${index + 1}. ${project.name}`, `proj:${token}`).row();
    });
    return [workspacePickerText(projects, this.config.workspaceRoot), { reply_markup: keyboard }];
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
    threads.forEach((thread, index) => {
      const token = this.pickers.threadToken({ chatId: ctx.chat!.id, userId: ctx.from!.id }, thread);
      keyboard.text(`${index + 1}. Resume`, `thread:${token}`).row();
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

    const active = this.sessions.getActiveSession();
    if (!active) {
      await ctx.reply("No active session. Start or resume a session before choosing a model.");
      return;
    }
    const keyboard = new InlineKeyboard();
    models.slice(0, 12).forEach((model, index) => {
      const token = this.pickers.modelToken({ chatId: ctx.chat!.id, userId: ctx.from!.id }, model, active);
      keyboard.text(`${index + 1}. ${model.id}`.slice(0, 60), `model:${token}`).row();
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
    const target = payload as { attachmentId?: string; target?: string; expectedVersion?: number };
    return this.callbacks.issue({
      actionId: target.attachmentId ?? target.target ?? createId("legacy_tmux"),
      resourceKind: target.attachmentId ? "legacy-tmux-attachment" : "legacy-tmux-target",
      ...(target.expectedVersion === undefined ? {} : { expectedVersion: target.expectedVersion }),
      chatId,
      userId,
      operation,
      payload,
      expiresAt: Date.now() + 10 * 60_000
    });
  }

  private async startProjectSession(ctx: Context, project: WorkspaceProject): Promise<void> {
    const canonicalProject = await resolveWorkspacePath(this.config.workspaceRoot, project.path);
    try {
      const session = await this.sessions.newSession({ cwd: canonicalProject.path, label: canonicalProject.name });
      await ctx.reply(`Started app-server session in ${canonicalProject.name}:\n${session.id}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown startup error.";
      this.logger.error({ err: error, projectName: canonicalProject.name }, "failed to start Codex app-server session from Telegram");
      await ctx.reply(
        [
          `Could not start Codex in ${canonicalProject.name}.`,
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
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    await withTemporaryTextExport("tele-codex-transcript-", filename, transcript,
      (path) => this.bot.api.sendDocument(chatId, new InputFile(path, filename)));
  }

  private async forwardCodexEvents(signal: AbortSignal): Promise<void> {
    for await (const event of this.sessions.events()) {
      if (signal.aborted) return;
      await this.handleCodexEvent(event);
      this.health.heartbeat("event-forwarder", event.type);
    }
  }

  private async handleCodexEvent(event: CodexEvent): Promise<void> {
    if (event.type === "agentMessage") {
      this.store.appendTranscript(event.sessionId, event.text, { turnId: event.turnId, itemId: event.itemId });
      const session = this.store.getSession(event.sessionId);
      if (!session || this.store.listSessionChats(event.sessionId).length === 0) return;
      this.bufferAgentMessage(event.sessionId, event.text);
      return;
    }

    if (event.type === "taskCompleted" && event.turnId) {
      this.store.finalizeTranscriptTurn(event.sessionId, event.turnId);
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
        const view = this.interactions.actionView(event.action, chatId, this.config.controllerUserId);
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
      return;
    }

    if (event.type === "goalChanged") {
      if (!["blocked", "usageLimited", "budgetLimited", "complete"].includes(event.goal.status)) return;
      for (const chatId of this.deliveryChatsForSession(event.sessionId)) {
        this.store.enqueueOutbox(`goal:${event.sessionId}:${event.goal.status}:${event.goal.updatedAt}`, chatId, {
          text: formatGoal(event.goal)
        });
      }
      return;
    }

    if (event.type === "rateLimitsChanged" && (event.recovered || event.limits.usedPercent >= this.config.rateLimitWarnPercent)) {
      const bucket = event.limits.usedPercent >= 100 ? 100 : event.limits.usedPercent >= 95 ? 95 : this.config.rateLimitWarnPercent;
      for (const chatId of this.deliveryChatsForSession(event.sessionId)) {
        this.store.enqueueOutbox(`limits:${event.recovered ? "recovered" : bucket}:${event.limits.resetsAt ?? "unknown"}`, chatId, {
          text: `${event.recovered ? "Codex rate limits recovered" : "Codex rate-limit warning"}\n\n${formatLimits(event.limits)}`
        });
      }
      return;
    }

    if (event.type === "warning") {
      for (const chatId of this.deliveryChatsForSession(event.sessionId)) {
        this.store.enqueueOutbox(`warning:${event.sessionId}:${createId("event")}`, chatId, {
          text: `Codex warning: ${event.message}`
        });
      }
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
          this.health.deliverySuccess();
          if (message.actionId) this.store.setTelegramMessage(message.actionId, message.chatId, sent.message_id);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.store.retryOutbox(message.id, message.attempts + 1, detail);
          this.health.deliveryFailure(error);
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

  private bufferAgentMessage(sessionId: string, text: string): void {
    if (!text.trim()) return;

    let buffer = this.messageBuffers.get(sessionId);
    if (!buffer) {
      buffer = { deliveries: new Map() };
      this.messageBuffers.set(sessionId, buffer);
    }
    for (const chatId of this.store.listSessionChats(sessionId)) {
      const delivery = buffer.deliveries.get(chatId);
      if (delivery) {
        delivery.text = appendAgentMessageChunk(delivery.text, text);
      } else {
        buffer.deliveries.set(chatId, { text: appendAgentMessageChunk("", text), attempts: 0 });
      }
    }
    this.scheduleAgentMessageFlush(sessionId, AGENT_MESSAGE_FLUSH_DELAY_MS);
  }

  private async flushAgentMessage(sessionId: string): Promise<void> {
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer) return;
    if (buffer.flushPromise) return buffer.flushPromise;
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      delete buffer.timer;
    }

    const flushPromise = this.deliverAgentMessageBuffer(sessionId, buffer);
    buffer.flushPromise = flushPromise;
    try {
      await flushPromise;
    } finally {
      delete buffer.flushPromise;
      if (buffer.deliveries.size === 0 && this.messageBuffers.get(sessionId) === buffer) {
        this.messageBuffers.delete(sessionId);
      }
    }
  }

  private async deliverAgentMessageBuffer(sessionId: string, buffer: AgentMessageBuffer): Promise<void> {
    const session = this.store.getSession(sessionId);
    const snapshots = [...buffer.deliveries].map(([chatId, delivery]) => ({
      chatId,
      text: delivery.text,
      attempt: delivery.attempts + 1
    }));
    let failureCount = 0;

    await Promise.all(snapshots.map(async ({ chatId, text, attempt }) => {
      try {
        const sent = await this.bot.api.sendMessage(chatId, formatAgentMessage(session, text));
        this.store.setMessageThread(chatId, sent.message_id, sessionId);
        const current = buffer.deliveries.get(chatId);
        if (!current) return;
        if (current.text === text) {
          buffer.deliveries.delete(chatId);
        } else if (current.text.startsWith(text)) {
          current.text = current.text.slice(text.length);
          current.attempts = 0;
        }
      } catch (error) {
        failureCount += 1;
        const diagnostic = sanitizedDeliveryError(error);
        const current = buffer.deliveries.get(chatId);
        if (current) current.attempts = attempt;
        this.health.deliveryFailure(diagnostic);
        if (attempt >= AGENT_MESSAGE_MAX_ATTEMPTS) {
          buffer.deliveries.delete(chatId);
          this.logger.warn(
            { error: diagnostic, sessionId, chatId, attempt },
            "buffered Telegram delivery dropped at retry limit"
          );
        } else {
          this.logger.warn(
            { error: diagnostic, sessionId, chatId, attempt },
            "buffered Telegram delivery failed; retry scheduled"
          );
        }
      }
    }));

    if (failureCount === 0 && snapshots.length > 0) this.health.deliverySuccess();
    const retryAttempts = [...buffer.deliveries.values()]
      .filter((delivery) => delivery.attempts > 0)
      .map((delivery) => delivery.attempts);
    if (retryAttempts.length > 0 && !buffer.timer) {
      const attempt = Math.min(...retryAttempts);
      this.scheduleAgentMessageFlush(sessionId, AGENT_MESSAGE_FLUSH_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  private scheduleAgentMessageFlush(sessionId: string, delayMs: number): void {
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer) return;
    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.timer = setTimeout(() => {
      delete buffer.timer;
      void this.flushAgentMessage(sessionId).catch((error) => {
        const diagnostic = sanitizedDeliveryError(error);
        this.health.deliveryFailure(diagnostic);
        this.logger.warn({ error: diagnostic, sessionId }, "buffered Telegram delivery failed unexpectedly");
      });
    }, delayMs);
  }

  private allowedDeliveryChats(): number[] {
    if (this.config.allowedChatIds.size > 0) return [...this.config.allowedChatIds];
    return [this.config.controllerUserId];
  }

  private deliveryChatsForSession(sessionId: string): number[] {
    const routed = this.store.listSessionChats(sessionId);
    return routed.length > 0 ? routed : this.allowedDeliveryChats();
  }
}

function sanitizedDeliveryError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(sanitizeDiagnosticText(detail));
}

function formatRuntimeHealth(
  snapshot: ReturnType<RuntimeHealth["snapshot"]> | undefined,
  counts: { session: string; pending: number; queued: number; failed: number; storage: ReturnType<Store["diagnostics"]> }
): string {
  if (!snapshot) {
    return [
      "tele-codex health: unavailable",
      `session: ${counts.session}`,
      `pending interactions: ${counts.pending}`,
      `delivery queue: ${counts.queued} pending, ${counts.failed} failed`,
      storageHealth(counts.storage)
    ].join("\n");
  }
  const app = snapshot.appServer;
  return [
    `tele-codex health: ${snapshot.overall}`,
    `lifecycle: ${snapshot.lifecycle}`,
    `app-server: ${app.state}${app.transport ? ` (${app.transport}${app.pid ? ` pid ${app.pid}` : ""})` : ""}`,
    `connection: generation ${app.connectionGeneration ?? "none"}, reconnect attempt ${app.reconnectAttempt}`,
    `last app-server message: ${formatHealthTime(app.lastMessageAt)}`,
    `last Telegram update: ${formatHealthTime(snapshot.lastTelegramUpdateAt)}`,
    `last delivery success: ${formatHealthTime(snapshot.delivery.lastSuccessAt)}`,
    `last delivery failure: ${formatHealthTime(snapshot.delivery.lastFailureAt)}${snapshot.delivery.lastFailure ? ` (${snapshot.delivery.lastFailure})` : ""}`,
    ...snapshot.subsystems.map((item) => `${item.name}: ${item.state}, heartbeat ${formatHealthTime(item.lastHeartbeatAt)}${item.detail ? ` (${item.detail})` : ""}`),
    `session: ${counts.session}`,
    `pending interactions: ${counts.pending}`,
    `delivery queue: ${counts.queued} pending, ${counts.failed} failed`,
    storageHealth(counts.storage),
    snapshot.lastFatal
      ? `last fatal: ${snapshot.lastFatal.subsystem} (${snapshot.lastFatal.correlationId}) at ${formatHealthTime(snapshot.lastFatal.at)}`
      : "last fatal: none"
  ].join("\n");
}

function storageHealth(storage: ReturnType<Store["diagnostics"]>): string {
  const size = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `storage: schema v${storage.schemaVersion}, database ${size(storage.databaseBytes)}, WAL ${size(storage.walBytes)}` +
    (storage.warnings.length > 0 ? `; WARN ${storage.warnings.join("; ")}` : "");
}

function formatHealthTime(value?: number): string {
  return value ? new Date(value).toISOString() : "never";
}

function waitForWorkerTick(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
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

function workspacePickerText(projects: WorkspaceProject[], workspaceRoot: string): string {
  return projects.length === 0
    ? `No project folders found under ${workspaceRoot}.`
    : `Start Codex in a workspace project:\n\n${projects
        .map((project, index) => `${index + 1}. ${project.name}`)
        .join("\n")}\n\nUse /new <project-or-path> for manual entry.`;
}

function formatStartupRecovery(recovery: StartupRecovery, sessions: StoredSession[]): string {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const affected = recovery.activeThreadIds.map((sessionId) => {
    const session = sessionsById.get(sessionId);
    return session ? `${session.label} (${session.id})` : sessionId;
  });
  return [
    "tele-codex restarted.",
    recovery.activeThreadIds.length > 0
      ? "The previous Active Turn outcome is unknown. Resume each affected Codex Thread explicitly before continuing."
      : undefined,
    affected.length > 0 ? `Affected Codex Threads:\n${affected.map((thread) => `- ${thread}`).join("\n")}` : undefined,
    recovery.orphanedActionIds.length > 0
      ? `${recovery.orphanedActionIds.length} previous pending request(s) were marked orphaned. Resume the thread and retry the original command.`
      : undefined,
    sessions.length > 0
      ? "Threads are not resumed automatically. Use the controls below to select a recoverable thread."
      : "No recoverable local thread metadata is available. Use /resume to inspect Codex history."
  ].filter(Boolean).join("\n\n");
}

function callbackError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
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

function formatLegacyCapture(result: LegacyCaptureResult): string {
  const heuristic = result.observations.find((item) => item.kind === "heuristic-interaction");
  return [
    `Legacy tmux capture: ${result.status}`,
    result.detail,
    heuristic
      ? `\nHEURISTIC ${String(heuristic.confidence ?? "unknown").toUpperCase()}: ${heuristic.reason ?? "terminal text resembled an interaction"}\nInspect the local pane; no Approve/Deny action was created.`
      : undefined,
    result.newOutput ? `\nNew output:\n${result.newOutput.slice(-3000)}` : undefined
  ].filter(Boolean).join("\n");
}
