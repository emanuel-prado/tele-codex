import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IPty } from "node-pty";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import { NotificationClassifier } from "../classifier/notification-classifier.js";
import { Store } from "../store/store.js";
import type { CodexAdapter } from "../types/adapter.js";
import type { AttachSession, CodexEvent, LogEntry, SessionRef, StartSession, UserDecision } from "../types/events.js";
import { AsyncQueue } from "../utils/async-queue.js";
import { createId } from "../utils/ids.js";
import { parseSubmitSequence, ptySubmitSequence } from "./submit-key.js";

const execFileAsync = promisify(execFile);
const DEFAULT_SUBMIT_STRATEGIES = [
  "enter",
  "f12",
  "ctrl-enter",
  "shift-enter",
  "ctrl-shift-enter",
  "esc-enter",
  "c-j",
  "c-m"
];

export interface TmuxPane {
  target: string;
  sessionName: string;
  windowIndex: string;
  paneIndex: string;
  command: string;
  title: string;
  active: boolean;
  preview: string;
}

export interface ProbeResult {
  sessionId: string;
  status: "needs-confirmation" | "paste-only" | "stale";
  strategy: string;
  probe: string;
  detail: string;
  preview?: string;
}

export class PtyAdapter implements CodexAdapter {
  readonly kind = "pty" as const;
  private readonly queue = new AsyncQueue<CodexEvent>();
  private readonly managedPtys = new Map<string, IPty>();
  private readonly tmuxTargets = new Map<string, string>();
  private readonly classifier: NotificationClassifier;

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly logger: Logger
  ) {
    this.classifier = new NotificationClassifier({ approvalTimeoutMs: config.approvalTimeoutMs });
  }

  async start(opts: StartSession): Promise<SessionRef> {
    const nodePty = await import("node-pty");
    const pty = nodePty.spawn(this.config.codexCommand, ["--no-alt-screen"], {
      name: "xterm-256color",
      cwd: opts.cwd ?? process.cwd(),
      env: process.env,
      cols: 100,
      rows: 32
    });
    const session = this.makeSession(opts.label ?? "Codex PTY", opts.cwd);
    this.managedPtys.set(session.id, pty);
    this.store.upsertSession(session, "attached");

    pty.onData((data) => this.handleOutput(session.id, data));
    pty.onExit(({ exitCode }) => {
      this.store.setSessionStatus(session.id, "stopped");
      this.queue.push({ type: "statusChanged", sessionId: session.id, status: "stopped", detail: `PTY exited: ${exitCode}` });
    });

    if (opts.prompt) pty.write(`${opts.prompt}${ptySubmitSequence(this.config.ptySubmitKey)}`);
    return session;
  }

  async attach(opts: AttachSession): Promise<SessionRef> {
    const target = opts.tmuxTarget ?? this.config.tmuxTarget;
    if (!target) throw new Error("PTY attach requires a tmux target, e.g. session:window.pane.");

    const session = this.makeSession(opts.label ?? `tmux ${target}`, opts.cwd, target);
    this.tmuxTargets.set(session.id, target);
    this.store.upsertSession(session, "attached");
    this.store.updateAttachState(session.id, {
      attachStatus: "unknown",
      submitStrategy: this.config.ptySubmitKey
    });
    await this.captureTmux(session.id, target);
    return session;
  }

  async sendUserText(sessionId: string, text: string): Promise<void> {
    const pty = this.managedPtys.get(sessionId);
    if (pty) {
      pty.write(`${text}\r`);
      return;
    }
    const target = this.tmuxTargets.get(sessionId);
    if (target) {
      const session = this.store.getSession(sessionId);
      if (session?.attachStatus === "paste-only") {
        await this.pasteTmuxText(target, text);
      } else if (session?.attachStatus !== "ready") {
        throw new Error(
          "Tmux input is not verified yet. Run /testinput, confirm that Codex answered the test prompt, then send the message again."
        );
      } else {
        await this.sendTmuxText(target, text, session?.submitStrategy ?? this.config.ptySubmitKey);
      }
      await this.captureTmux(sessionId, target);
      return;
    }
    throw new Error(`Unknown PTY session: ${sessionId}`);
  }

  async respondAction(decision: UserDecision): Promise<void> {
    const action = this.store.getPendingAction(decision.actionId);
    if (!action) throw new Error("Pending PTY action not found.");
    if (action.kind === "question") {
      if (!decision.text) throw new Error("Question responses require text.");
      await this.sendUserText(action.sessionId, decision.text);
    } else {
      await this.sendUserText(action.sessionId, decision.decision === "decline" ? "n" : "y");
    }
    this.store.resolvePendingAction(action.id, "resolved");
  }

  async interrupt(sessionId: string): Promise<void> {
    const pty = this.managedPtys.get(sessionId);
    if (pty) {
      pty.write("\u0003");
      return;
    }
    const target = this.tmuxTargets.get(sessionId);
    if (target) await execFileAsync("tmux", ["send-keys", "-t", target, "C-c"]);
  }

  async kill(sessionId: string): Promise<void> {
    const pty = this.managedPtys.get(sessionId);
    if (pty) {
      pty.kill();
      this.managedPtys.delete(sessionId);
    }
    const target = this.tmuxTargets.get(sessionId);
    if (target) {
      await execFileAsync("tmux", ["send-keys", "-t", target, "C-c"]);
    }
    this.store.setSessionStatus(sessionId, "stopped");
  }

  async getRecentLog(sessionId: string, limit: number): Promise<LogEntry[]> {
    return this.store.recentLogs(sessionId, limit);
  }

  async listTmuxPanes(): Promise<TmuxPane[]> {
    const format = [
      "#{session_name}",
      "#{window_index}",
      "#{pane_index}",
      "#{pane_current_command}",
      "#{pane_title}",
      "#{pane_active}"
    ].join("\t");
    const { stdout } = await execFileAsync("tmux", ["list-panes", "-a", "-F", format]);
    const panes = await Promise.all(
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(async (line) => {
          const [sessionName = "", windowIndex = "", paneIndex = "", command = "", title = "", active = "0"] =
            line.split("\t");
          const target = `${sessionName}:${windowIndex}.${paneIndex}`;
          return {
            target,
            sessionName,
            windowIndex,
            paneIndex,
            command,
            title,
            active: active === "1",
            preview: await this.captureTmuxPreview(target)
          };
        })
    );
    return panes;
  }

  async probeSession(sessionId: string, strategy?: string): Promise<ProbeResult> {
    const session = this.store.getSession(sessionId);
    if (!session?.tmuxTarget) throw new Error("Active session is not a tmux attachment.");
    const selectedStrategy = strategy ?? session.submitStrategy ?? this.config.ptySubmitKey;
    const probe = `TELE_CODEX_PROBE_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const prompt = `Reply exactly ${probe}`;

    this.store.updateAttachState(sessionId, {
      attachStatus: "probing",
      submitStrategy: selectedStrategy,
      lastProbe: probe,
      lastProbeAt: Date.now()
    });

    await this.sendTmuxText(session.tmuxTarget, prompt, selectedStrategy);
    await wait(8_000);
    const output = await this.captureTmuxPreview(session.tmuxTarget, 120);
    const status = "needs-confirmation";
    this.store.updateAttachState(sessionId, {
      attachStatus: status,
      submitStrategy: selectedStrategy,
      lastProbe: probe,
      lastProbeAt: Date.now()
    });
    this.handleOutput(sessionId, output);
    return {
      sessionId,
      status,
      strategy: selectedStrategy,
      probe,
      detail:
        "A test prompt was sent through the same tmux path used for normal Telegram messages. Confirm it only if Codex actually answered the probe.",
      preview: output.slice(-800)
    };
  }

  async tryNextStrategy(sessionId: string): Promise<ProbeResult> {
    const session = this.store.getSession(sessionId);
    if (!session?.tmuxTarget) throw new Error("Active session is not a tmux attachment.");
    const current = session.submitStrategy ?? this.config.ptySubmitKey;
    const candidates = unique([this.config.ptySubmitKey, ...DEFAULT_SUBMIT_STRATEGIES]);
    const currentIndex = candidates.indexOf(current);
    const next = candidates[(currentIndex + 1) % candidates.length] ?? candidates[0] ?? "enter";
    return this.probeSession(sessionId, next);
  }

  markManualSubmit(sessionId: string): void {
    this.store.updateAttachState(sessionId, {
      attachStatus: "paste-only"
    });
  }

  markReady(sessionId: string): void {
    const session = this.store.getSession(sessionId);
    if (!session?.tmuxTarget) throw new Error("Active session is not a tmux attachment.");
    this.store.updateAttachState(sessionId, {
      attachStatus: "ready"
    });
  }

  events(): AsyncIterable<CodexEvent> {
    return this.queue;
  }

  private makeSession(label: string, cwd?: string, tmuxTarget?: string): SessionRef {
    const session: SessionRef = {
      id: createId("session"),
      adapter: "pty",
      label,
      cwd: cwd ?? process.cwd()
    };
    if (tmuxTarget) session.tmuxTarget = tmuxTarget;
    return session;
  }

  private async captureTmux(sessionId: string, target: string): Promise<void> {
    const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-J", "-t", target]);
    this.handleOutput(sessionId, stdout);
  }

  private async sendTmuxText(target: string, text: string, submitStrategy: string): Promise<void> {
    await this.pasteTmuxText(target, text);
    await wait(this.config.ptyPasteSettleMs);
    for (const step of parseSubmitSequence(submitStrategy)) {
      if (step.type === "literal") {
        await execFileAsync("tmux", ["send-keys", "-t", target, "-l", step.value]);
      } else {
        await execFileAsync("tmux", ["send-keys", "-t", target, step.key]);
      }
      await wait(50);
    }
  }

  private async pasteTmuxText(target: string, text: string): Promise<void> {
    const bufferName = `tele-codex-${createId("paste")}`;
    await execFileAsync("tmux", ["set-buffer", "-b", bufferName, text]);
    await execFileAsync("tmux", ["paste-buffer", "-d", "-p", "-b", bufferName, "-t", target]);
  }

  private async captureTmuxPreview(target: string, lines = 30): Promise<string> {
    const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", target]);
    return stdout.trim();
  }

  private handleOutput(sessionId: string, data: string): void {
    const summary = this.classifier.summarizeLog(data);
    if (summary) {
      this.store.appendLog({ sessionId, type: "pty.output", severity: "info", text: summary });
      this.queue.push({
        type: "agentMessage",
        sessionId,
        text: summary
      });
    }

    const action = this.classifier.classifyPtyOutput(sessionId, data);
    if (!action) return;

    this.logger.debug({ actionId: action.id }, "classified PTY pending action");
    this.store.putPendingAction(action);
    this.queue.push({
      type: action.kind === "question" ? "questionAsked" : "approvalRequested",
      sessionId,
      action
    });
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
