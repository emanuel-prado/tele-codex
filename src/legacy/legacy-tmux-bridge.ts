import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import { Store } from "../store/store.js";
import type { LegacyTmuxAttachment } from "../types/legacy-tmux.js";
import { createId } from "../utils/ids.js";
import { parseSubmitSequence } from "../adapters/submit-key.js";

const execFileAsync = promisify(execFile);
const DEFAULT_SUBMIT_STRATEGIES = ["enter", "f12", "ctrl-enter", "shift-enter", "ctrl-shift-enter", "esc-enter", "c-j", "c-m"];

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

export type TmuxCommandRunner = (file: string, args: string[]) => Promise<{ stdout: string }>;

export class LegacyTmuxBridge {
  constructor(
    private readonly config: Pick<AppConfig, "tmuxSubmitKey" | "tmuxPasteSettleMs">,
    private readonly store: Store,
    private readonly logger: Logger,
    private readonly run: TmuxCommandRunner = async (file, args) => execFileAsync(file, args),
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  async listPanes(): Promise<TmuxPane[]> {
    const format = ["#{session_name}", "#{window_index}", "#{pane_index}", "#{pane_current_command}", "#{pane_title}", "#{pane_active}"].join("\t");
    const { stdout } = await this.tmux(["list-panes", "-a", "-F", format]);
    return Promise.all(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(async (line) => {
      const [sessionName = "", windowIndex = "", paneIndex = "", command = "", title = "", active = "0"] = line.split("\t");
      const target = `${sessionName}:${windowIndex}.${paneIndex}`;
      return {
        target,
        sessionName,
        windowIndex,
        paneIndex,
        command,
        title,
        active: active === "1",
        preview: await this.capturePreview(target)
      };
    }));
  }

  async attach(target: string, chatId: number, label = `tmux ${target}`): Promise<LegacyTmuxAttachment> {
    await this.capturePreview(target);
    return this.store.upsertLegacyTmuxAttachment({
      id: createId("tmux"),
      target,
      label,
      chatId,
      status: "attached",
      inputStatus: "unknown",
      submitStrategy: this.config.tmuxSubmitKey
    });
  }

  listAttachments(chatId: number): LegacyTmuxAttachment[] {
    return this.store.listLegacyTmuxAttachments(chatId);
  }

  async send(attachmentId: string, chatId: number, text: string): Promise<string> {
    const attachment = this.requireAttachment(attachmentId, chatId);
    if (attachment.inputStatus === "paste-only") {
      await this.pasteText(attachment.target, text);
    } else if (attachment.inputStatus !== "ready") {
      throw new Error("Legacy tmux input is not verified. Run /tmux test <attachment-id> first.");
    } else {
      await this.sendText(attachment.target, text, attachment.submitStrategy);
    }
    return this.capturePreview(attachment.target);
  }

  async interrupt(attachmentId: string, chatId: number): Promise<void> {
    const attachment = this.requireAttachment(attachmentId, chatId);
    await this.tmux(["send-keys", "-t", attachment.target, "C-c"]);
  }

  async probe(attachmentId: string, chatId: number, strategy?: string): Promise<ProbeResult> {
    const attachment = this.requireAttachment(attachmentId, chatId);
    const selectedStrategy = strategy ?? attachment.submitStrategy;
    const probe = `TELE_CODEX_PROBE_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    this.store.updateLegacyTmuxAttachment(attachmentId, {
      inputStatus: "probing",
      submitStrategy: selectedStrategy,
      lastProbe: probe,
      lastProbeAt: Date.now()
    });
    try {
      await this.sendText(attachment.target, `Reply exactly ${probe}`, selectedStrategy);
      await this.wait(8_000);
      const preview = await this.capturePreview(attachment.target, 120);
      this.store.updateLegacyTmuxAttachment(attachmentId, { inputStatus: "needs-confirmation", lastProbeAt: Date.now() });
      return {
        sessionId: attachmentId,
        status: "needs-confirmation",
        strategy: selectedStrategy,
        probe,
        detail: "Legacy fallback sent a heuristic tmux probe. Confirm only after checking the pane locally.",
        preview: preview.slice(-800)
      };
    } catch (error) {
      this.store.updateLegacyTmuxAttachment(attachmentId, { status: "stale", inputStatus: "stale" });
      throw error;
    }
  }

  async tryNextStrategy(attachmentId: string, chatId: number): Promise<ProbeResult> {
    const attachment = this.requireAttachment(attachmentId, chatId);
    const candidates = [...new Set([this.config.tmuxSubmitKey, ...DEFAULT_SUBMIT_STRATEGIES])];
    const index = candidates.indexOf(attachment.submitStrategy);
    return this.probe(attachmentId, chatId, candidates[(index + 1) % candidates.length] ?? "enter");
  }

  markPasteOnly(attachmentId: string, chatId: number): void {
    this.requireAttachment(attachmentId, chatId);
    this.store.updateLegacyTmuxAttachment(attachmentId, { inputStatus: "paste-only" });
  }

  markReady(attachmentId: string, chatId: number): void {
    this.requireAttachment(attachmentId, chatId);
    this.store.updateLegacyTmuxAttachment(attachmentId, { inputStatus: "ready" });
  }

  private requireAttachment(id: string, chatId: number): LegacyTmuxAttachment {
    const attachment = this.store.getLegacyTmuxAttachment(id);
    if (!attachment) throw new Error(`Unknown legacy tmux attachment: ${id}`);
    if (attachment.chatId !== chatId) throw new Error("Legacy tmux attachment belongs to another chat.");
    if (attachment.status === "stale") throw new Error("Legacy tmux attachment is stale. Attach the pane again.");
    return attachment;
  }

  private async sendText(target: string, text: string, strategy: string): Promise<void> {
    await this.pasteText(target, text);
    await this.wait(this.config.tmuxPasteSettleMs);
    for (const step of parseSubmitSequence(strategy)) {
      await this.tmux(step.type === "literal" ? ["send-keys", "-t", target, "-l", step.value] : ["send-keys", "-t", target, step.key]);
      await this.wait(50);
    }
  }

  private async pasteText(target: string, text: string): Promise<void> {
    const buffer = `tele-codex-${createId("paste")}`;
    await this.tmux(["set-buffer", "-b", buffer, text]);
    await this.tmux(["paste-buffer", "-d", "-p", "-b", buffer, "-t", target]);
  }

  private async capturePreview(target: string, lines = 30): Promise<string> {
    const { stdout } = await this.tmux(["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", target]);
    return stdout.trim();
  }

  private async tmux(args: string[]): Promise<{ stdout: string }> {
    try {
      return await this.run("tmux", args);
    } catch (error) {
      this.logger.warn({ error, args }, "legacy tmux command failed");
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Legacy tmux fallback failed: ${detail}`);
    }
  }
}
