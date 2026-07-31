import type { RateLimitSummary, ThreadGoalSummary } from "./control.js";

export type AdapterKind = "appserver" | "pty";

export type SessionStatus =
  | "starting"
  | "attached"
  | "idle"
  | "active"
  | "paused"
  | "blocked"
  | "error"
  | "stopped";

export type ApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

export type ActionKind =
  | "commandApproval"
  | "fileChangeApproval"
  | "permissionsApproval"
  | "question"
  | "mcpElicitation"
  | "killConfirm";

export interface SessionRef {
  id: string;
  adapter: AdapterKind;
  label: string;
  cwd?: string;
  codexThreadId?: string;
  connectionGeneration?: number;
  tmuxTarget?: string;
  attachStatus?: "ready" | "probing" | "needs-confirmation" | "paste-only" | "stale" | "unknown";
  submitStrategy?: string;
  lastProbe?: string;
  lastProbeAt?: number;
}

export interface StartSession {
  cwd?: string;
  prompt?: string;
  label?: string;
  adapter?: AdapterKind;
  model?: string;
}

export interface AttachSession {
  adapter: AdapterKind;
  codexThreadId?: string;
  tmuxTarget?: string;
  label?: string;
  cwd?: string;
  model?: string;
}

export interface PendingAction {
  id: string;
  kind: ActionKind;
  sessionId: string;
  requestId?: string | number;
  connectionGeneration?: number;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  title: string;
  body: string;
  payload: unknown;
  nonce: string;
  expiresAt: number;
}

export type CodexEvent =
  | {
      type: "approvalRequested";
      sessionId: string;
      action: PendingAction;
    }
  | {
      type: "questionAsked";
      sessionId: string;
      action: PendingAction;
    }
  | {
      type: "agentMessage";
      sessionId: string;
      text: string;
      itemId?: string;
      turnId?: string;
      final?: boolean;
    }
  | {
      type: "taskCompleted";
      sessionId: string;
      summary: string;
      status: "completed" | "failed" | "interrupted";
      turnId?: string;
    }
  | {
      type: "error";
      sessionId: string;
      message: string;
      willRetry?: boolean;
      turnId?: string;
    }
  | {
      type: "blocked";
      sessionId: string;
      reason: string;
    }
  | {
      type: "statusChanged";
      sessionId: string;
      status: SessionStatus;
      detail?: string;
    }
  | {
      type: "goalChanged";
      sessionId: string;
      goal: ThreadGoalSummary;
    }
  | {
      type: "rateLimitsChanged";
      sessionId: string;
      limits: RateLimitSummary;
      recovered?: boolean;
    }
  | {
      type: "actionResolved";
      sessionId: string;
      actionId: string;
    }
  | {
      type: "actionOrphaned";
      sessionId: string;
      actionId: string;
      message: string;
    }
  | {
      type: "warning";
      sessionId: string;
      message: string;
    }
  | {
      type: "logChunk";
      sessionId: string;
      text: string;
      severity: "debug" | "info" | "warn" | "error";
    };

export interface LogEntry {
  id: number;
  sessionId: string;
  timestamp: number;
  type: string;
  severity: "debug" | "info" | "warn" | "error";
  text: string;
  payload?: unknown;
}

export interface UserDecision {
  actionId: string;
  decision: ApprovalDecision;
  text?: string;
  answers?: Record<string, { answers: string[] }>;
  content?: unknown;
  permissionScope?: "turn" | "session";
  protocolDecision?: unknown;
  grantForSession?: boolean;
}
