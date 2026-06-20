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

export interface RateLimitSummary {
  usedPercent: number;
  resetsAt?: number;
  windowDurationMins?: number;
  planType?: string;
  updatedAt: number;
}

export interface TurnPlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

export interface SessionProgress {
  explanation?: string;
  plan: TurnPlanStep[];
  updatedAt: number;
}

export interface ThreadGoalSummary {
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  updatedAt: number;
}

export interface BackgroundTerminalSummary {
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
  osPid?: number;
  cpuPercent?: number;
  rssKb?: number;
}
