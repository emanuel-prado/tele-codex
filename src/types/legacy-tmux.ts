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
  createdAt: number;
  updatedAt: number;
}
