import type {
  AttachSession,
  CodexEvent,
  LogEntry,
  SessionRef,
  StartSession,
  UserDecision
} from "./events.js";
import type {
  BackgroundTerminalSummary,
  CodexModelSummary,
  CodexThreadSummary,
  CollaborationModeKind,
  RateLimitSummary,
  SessionControlOptions,
  ThreadGoalSummary
} from "./control.js";
import type { StoredSession } from "../store/store.js";

export interface CodexAdapter {
  readonly kind: "appserver" | "pty";
  start(opts: StartSession): Promise<SessionRef>;
  attach(opts: AttachSession): Promise<SessionRef>;
  resume?(session: StoredSession): Promise<SessionRef>;
  detach?(sessionId: string): Promise<void>;
  sendUserText(sessionId: string, text: string): Promise<void>;
  respondAction(decision: UserDecision): Promise<void>;
  updateSettings?(sessionId: string, options: SessionControlOptions): Promise<void>;
  listModels?(limit?: number): Promise<CodexModelSummary[]>;
  listThreads?(limit?: number): Promise<CodexThreadSummary[]>;
  searchThreads?(term: string, limit?: number): Promise<CodexThreadSummary[]>;
  resumeThread?(threadId: string, options?: SessionControlOptions): Promise<SessionRef>;
  compactThread?(sessionId: string): Promise<void>;
  archiveThread?(sessionId: string): Promise<void>;
  setCollaborationMode?(sessionId: string, mode: CollaborationModeKind): Promise<void>;
  readRateLimits?(): Promise<RateLimitSummary | undefined>;
  getGoal?(sessionId: string): Promise<ThreadGoalSummary | undefined>;
  setGoal?(sessionId: string, objective?: string, status?: ThreadGoalSummary["status"]): Promise<ThreadGoalSummary>;
  clearGoal?(sessionId: string): Promise<boolean>;
  listBackgroundTerminals?(sessionId: string): Promise<BackgroundTerminalSummary[]>;
  terminateBackgroundTerminal?(sessionId: string, processId: string): Promise<boolean>;
  interrupt(sessionId: string): Promise<void>;
  kill(sessionId: string): Promise<void>;
  getRecentLog(sessionId: string, limit: number): Promise<LogEntry[]>;
  close?(): void | Promise<void>;
  events(): AsyncIterable<CodexEvent>;
}
