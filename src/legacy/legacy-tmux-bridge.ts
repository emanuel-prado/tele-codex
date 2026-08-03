import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import { Store } from "../store/store.js";
import type { LegacyTmuxAttachment } from "../types/legacy-tmux.js";
import { createId } from "../utils/ids.js";
import { parseSubmitSequence } from "../adapters/submit-key.js";
import { NotificationClassifier, stripAnsi, type HeuristicInteraction } from "../classifier/notification-classifier.js";
import type { LegacyTmuxObservation } from "../types/legacy-tmux.js";

const execFileAsync = promisify(execFile);
const DEFAULT_SUBMIT_STRATEGIES = ["enter", "f12", "ctrl-enter", "shift-enter", "ctrl-shift-enter", "esc-enter", "c-j", "c-m"];
const COMMAND_TIMEOUT_MS = 5_000;
const MAX_CAPTURE_LINES = 200;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024;
const INTERACTION_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

export interface TmuxPane {
  target: string;
  sessionName: string;
  windowIndex: string;
  paneIndex: string;
  command: string;
  title: string;
  active: boolean;
  preview: string;
  paneIdentity: string;
}

export interface ProbeResult {
  sessionId: string;
  status: "needs-confirmation" | "paste-only" | "stale";
  strategy: string;
  probe: string;
  detail: string;
  preview?: string;
}

export interface LegacyCaptureResult {
  attachmentId: string;
  status: "unchanged" | "updated" | "uncertain" | "stale";
  newOutput: string;
  preview: string;
  observations: LegacyTmuxObservation[];
  detail: string;
}

export interface TmuxRunOptions {
  timeoutMs: number;
  maxBuffer: number;
}

export type TmuxCommandRunner = (file: string, args: string[], options: TmuxRunOptions) => Promise<{ stdout: string }>;

interface PaneSnapshot {
  identity: string;
  position: number;
  text: string;
  hash: string;
}

export class LegacyTmuxBridge {
  private readonly classifier = new NotificationClassifier();

  constructor(
    private readonly config: Pick<AppConfig, "tmuxSubmitKey" | "tmuxPasteSettleMs">,
    private readonly store: Store,
    private readonly logger: Logger,
    private readonly run: TmuxCommandRunner = async (file, args, options) => {
      const result = await execFileAsync(file, args, { timeout: options.timeoutMs, maxBuffer: options.maxBuffer });
      return { stdout: String(result.stdout) };
    },
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  async listPanes(): Promise<TmuxPane[]> {
    const format = ["#{session_name}", "#{window_index}", "#{pane_index}", "#{pane_current_command}", "#{pane_title}", "#{pane_active}", "#{pane_id}", "#{pane_pid}"].join("\t");
    const { stdout } = await this.tmux(["list-panes", "-a", "-F", format]);
    const panes = await Promise.all(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(async (line) => {
      const [sessionName = "", windowIndex = "", paneIndex = "", command = "", title = "", active = "0", paneId = "", panePid = ""] = line.split("\t");
      const target = `${sessionName}:${windowIndex}.${paneIndex}`;
      return {
        target,
        sessionName,
        windowIndex,
        paneIndex,
        command,
        title,
        active: active === "1",
        preview: await this.capturePreview(target),
        paneIdentity: `${paneId}:${panePid}`
      };
    }));
    const byTarget = new Map(panes.map((pane) => [pane.target, pane]));
    for (const attachment of this.store.listLegacyTmuxAttachments()) {
      if (attachment.status === "stale") continue;
      const pane = byTarget.get(attachment.target);
      if (!pane || (attachment.paneIdentity && attachment.paneIdentity !== pane.paneIdentity)) {
        this.store.updateLegacyTmuxAttachment(attachment.id, { status: "stale", inputStatus: "stale" });
      }
    }
    return panes;
  }

  async attach(target: string, chatId: number, label = `tmux ${target}`): Promise<LegacyTmuxAttachment> {
    const snapshot = await this.readPane(target);
    const attachment = this.store.upsertLegacyTmuxAttachment({
      id: createId("tmux"),
      target,
      label,
      chatId,
      status: "attached",
      inputStatus: "unknown",
      submitStrategy: this.config.tmuxSubmitKey
    });
    this.store.updateLegacyTmuxCapture(attachment.id, captureState(snapshot));
    return this.store.getLegacyTmuxAttachment(attachment.id)!;
  }

  listAttachments(chatId: number): LegacyTmuxAttachment[] {
    return this.store.listLegacyTmuxAttachments(chatId);
  }

  async send(attachmentId: string, chatId: number, text: string): Promise<string> {
    const attachment = this.requireAttachment(attachmentId, chatId);
    try {
      await this.assertPaneIdentity(attachment);
      if (attachment.inputStatus === "paste-only") {
        await this.pasteText(attachment.target, text);
      } else if (attachment.inputStatus !== "ready") {
        throw new Error("Legacy tmux input is not verified. Run /tmux test <attachment-id> first.");
      } else {
        await this.sendText(attachment.target, text, attachment.submitStrategy);
      }
    } catch (error) {
      if (isPaneFailure(error)) this.markStale(attachment.id);
      throw error;
    }
    const result = await this.capture(attachmentId, chatId);
    if (result.status === "stale") throw new Error(result.detail);
    return result.preview;
  }

  async interrupt(attachmentId: string, chatId: number): Promise<void> {
    const attachment = this.requireAttachment(attachmentId, chatId);
    try {
      await this.assertPaneIdentity(attachment);
      await this.tmux(["send-keys", "-t", attachment.target, "C-c"]);
    } catch (error) {
      this.markStale(attachment.id);
      throw error;
    }
  }

  async capture(attachmentId: string, chatId: number): Promise<LegacyCaptureResult> {
    const attachment = this.requireAttachment(attachmentId, chatId);
    let snapshot: PaneSnapshot;
    try {
      snapshot = await this.readPane(attachment.target);
    } catch (error) {
      this.markStale(attachment.id);
      return {
        attachmentId,
        status: "stale",
        newOutput: "",
        preview: "",
        observations: [],
        detail: error instanceof Error ? error.message : "The tmux pane is unavailable."
      };
    }
    if (attachment.paneIdentity && attachment.paneIdentity !== snapshot.identity) {
      this.markStale(attachment.id);
      return {
        attachmentId,
        status: "stale",
        newOutput: "",
        preview: snapshot.text.slice(-800),
        observations: [],
        detail: "The tmux target now refers to a different pane. Attach it again explicitly."
      };
    }

    const delta = incrementalOutput(attachment, snapshot);
    this.store.updateLegacyTmuxCapture(attachment.id, captureState(snapshot));
    if (!delta.text) {
      return {
        attachmentId,
        status: delta.uncertain ? "uncertain" : "unchanged",
        newOutput: "",
        preview: snapshot.text.slice(-800),
        observations: [],
        detail: delta.uncertain
          ? "Pane content changed without a reliable forward boundary; skipped it to avoid replaying scrollback."
          : "No new tmux output."
      };
    }

    const observedAt = Date.now();
    const observations: LegacyTmuxObservation[] = [];
    const output = this.observation(attachment.id, snapshot, "output", delta.text, observedAt);
    if (this.store.appendLegacyTmuxObservation(output)) observations.push(output);
    const interaction = this.classifier.classifyLegacyOutput(delta.text);
    if (interaction) {
      const warning = this.interactionObservation(attachment.id, snapshot, interaction, observedAt);
      const recentlySeen = this.store.hasRecentLegacyTmuxObservation({
        attachmentId: attachment.id,
        paneIdentity: snapshot.identity,
        kind: "heuristic-interaction",
        text: interaction.prompt,
        since: observedAt - INTERACTION_DEDUPE_WINDOW_MS
      });
      if (!recentlySeen && this.store.appendLegacyTmuxObservation(warning)) observations.push(warning);
    }
    return {
      attachmentId,
      status: "updated",
      newOutput: delta.text,
      preview: snapshot.text.slice(-800),
      observations,
      detail: observations.some((item) => item.kind === "heuristic-interaction")
        ? "Heuristic fallback signal detected. Inspect the local pane before responding; no approval action was created."
        : "Captured new legacy tmux output."
    };
  }

  async probe(attachmentId: string, chatId: number, strategy?: string): Promise<ProbeResult> {
    const attachment = this.requireAttachment(attachmentId, chatId);
    try {
      await this.assertPaneIdentity(attachment);
    } catch (error) {
      this.markStale(attachment.id);
      throw error;
    }
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
      const result = await this.capture(attachment.id, chatId);
      if (result.status === "stale") throw new Error(result.detail);
      const preview = result.preview;
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

  private async assertPaneIdentity(attachment: LegacyTmuxAttachment): Promise<void> {
    const snapshot = await this.readPane(attachment.target, 1);
    if (attachment.paneIdentity && snapshot.identity !== attachment.paneIdentity) {
      throw new Error("Legacy tmux target was replaced by a different pane. Attach it again.");
    }
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
    return boundedCapture(stdout);
  }

  private async readPane(target: string, lines = MAX_CAPTURE_LINES): Promise<PaneSnapshot> {
    const format = ["#{pane_id}", "#{pane_pid}", "#{history_size}", "#{cursor_y}", "#{pane_dead}"].join("\t");
    const { stdout: info } = await this.tmux(["display-message", "-p", "-t", target, format]);
    const [paneId, panePid, history = "0", cursor = "0", dead = "0"] = info.trim().split("\t");
    if (!paneId || !panePid || dead === "1") throw new Error(`Legacy tmux pane ${target} is unavailable or dead.`);
    const text = await this.capturePreview(target, Math.min(lines, MAX_CAPTURE_LINES));
    return {
      identity: `${paneId}:${panePid}`,
      position: Math.max(0, Number(history) || 0) + Math.max(0, Number(cursor) || 0),
      text,
      hash: contentHash(text)
    };
  }

  private async tmux(args: string[]): Promise<{ stdout: string }> {
    try {
      return await this.run("tmux", args, { timeoutMs: COMMAND_TIMEOUT_MS, maxBuffer: MAX_COMMAND_OUTPUT_BYTES });
    } catch (error) {
      const detail = error instanceof Error && /ENOENT/.test(error.message)
        ? "tmux executable was not found (ENOENT)."
        : "tmux command failed.";
      this.logger.warn({ operation: args[0], error: detail }, "legacy tmux command failed");
      throw new Error(`Legacy tmux fallback failed: ${detail}`);
    }
  }

  private markStale(attachmentId: string): void {
    this.store.updateLegacyTmuxAttachment(attachmentId, { status: "stale", inputStatus: "stale" });
  }

  private observation(
    attachmentId: string,
    snapshot: PaneSnapshot,
    kind: LegacyTmuxObservation["kind"],
    text: string,
    observedAt: number
  ): LegacyTmuxObservation {
    return {
      eventKey: contentHash(`${attachmentId}\0${snapshot.identity}\0${snapshot.position}\0${kind}\0${text}`),
      attachmentId,
      paneIdentity: snapshot.identity,
      capturePosition: snapshot.position,
      kind,
      text,
      observedAt
    };
  }

  private interactionObservation(
    attachmentId: string,
    snapshot: PaneSnapshot,
    interaction: HeuristicInteraction,
    observedAt: number
  ): LegacyTmuxObservation {
    return {
      ...this.observation(attachmentId, snapshot, "heuristic-interaction", interaction.prompt, observedAt),
      confidence: interaction.confidence,
      reason: interaction.reason
    };
  }
}

function captureState(snapshot: PaneSnapshot): Pick<LegacyTmuxAttachment, "paneIdentity" | "capturePosition" | "captureHash" | "captureTail" | "lastCaptureAt"> {
  return {
    paneIdentity: snapshot.identity,
    capturePosition: snapshot.position,
    captureHash: snapshot.hash,
    captureTail: snapshot.text,
    lastCaptureAt: Date.now()
  };
}

function incrementalOutput(attachment: LegacyTmuxAttachment, snapshot: PaneSnapshot): { text: string; uncertain: boolean } {
  if (!attachment.captureHash || attachment.captureTail === undefined || attachment.capturePosition === undefined) {
    return { text: "", uncertain: false };
  }
  if (attachment.captureHash === snapshot.hash) return { text: "", uncertain: false };
  const previous = lines(attachment.captureTail);
  const current = lines(snapshot.text);
  const overlap = suffixPrefixOverlap(previous, current);
  if (overlap > 0) return { text: current.slice(overlap).join("\n").trim(), uncertain: false };
  const advanced = snapshot.position - attachment.capturePosition;
  if (advanced > 0) return { text: current.slice(-Math.min(advanced, current.length)).join("\n").trim(), uncertain: false };
  return { text: "", uncertain: true };
}

function suffixPrefixOverlap(previous: string[], current: string[]): number {
  for (let size = Math.min(previous.length, current.length); size > 0; size -= 1) {
    let matches = true;
    for (let index = 0; index < size; index += 1) {
      if (previous[previous.length - size + index] !== current[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return size;
  }
  return 0;
}

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trimEnd());
}

function boundedCapture(value: string): string {
  const normalized = stripAnsi(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
  return Buffer.byteLength(normalized, "utf8") <= MAX_CAPTURE_BYTES
    ? normalized
    : Buffer.from(normalized, "utf8").subarray(-MAX_CAPTURE_BYTES).toString("utf8");
}

function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isPaneFailure(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /pane|tmux target|can't find|unavailable|dead/i.test(detail);
}
