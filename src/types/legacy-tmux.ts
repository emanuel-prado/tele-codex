export type LegacyTmuxStatus = "attached" | "stale";
export type LegacyTmuxInputStatus = "unknown" | "probing" | "needs-confirmation" | "ready" | "paste-only" | "stale";

export interface LegacyTmuxAttachment {
  id: string;
  target: string;
  label: string;
  cwd?: string;
  chatId: number;
  status: LegacyTmuxStatus;
  inputStatus: LegacyTmuxInputStatus;
  submitStrategy: string;
  lastProbe?: string;
  lastProbeAt?: number;
  paneIdentity?: string;
  capturePosition?: number;
  captureHash?: string;
  captureTail?: string;
  lastCaptureAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface LegacyTmuxObservation {
  eventKey: string;
  attachmentId: string;
  paneIdentity: string;
  capturePosition: number;
  kind: "output" | "heuristic-interaction" | "diagnostic";
  text: string;
  confidence?: "high" | "medium" | "low";
  reason?: string;
  observedAt: number;
}
