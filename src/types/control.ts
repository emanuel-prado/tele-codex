export type CollaborationModeKind = "default" | "plan";

export interface CodexModelSummary {
  id: string;
  displayName: string;
  description?: string;
  hidden?: boolean;
}

export interface CodexThreadSummary {
  id: string;
  name?: string;
  preview?: string;
  cwd?: string;
  modelProvider?: string;
  status?: string;
  updatedAt?: number;
}

export interface SessionControlOptions {
  model?: string;
  mode?: CollaborationModeKind;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface SessionTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow?: number;
  updatedAt: number;
}
