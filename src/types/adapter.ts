import type {
  AttachSession,
  CodexEvent,
  LogEntry,
  SessionRef,
  StartSession,
  UserDecision
} from "./events.js";
import type { CodexModelSummary, CodexThreadSummary, CollaborationModeKind, SessionControlOptions } from "./control.js";
import type { StoredSession } from "../store/store.js";

export interface CodexAdapter {
  readonly kind: "appserver" | "pty";
  start(opts: StartSession): Promise<SessionRef>;
  attach(opts: AttachSession): Promise<SessionRef>;
  resume?(session: StoredSession): Promise<SessionRef>;
  sendUserText(sessionId: string, text: string): Promise<void>;
  respondAction(decision: UserDecision): Promise<void>;
  updateSettings?(sessionId: string, options: SessionControlOptions): Promise<void>;
  listModels?(limit?: number): Promise<CodexModelSummary[]>;
  listThreads?(limit?: number): Promise<CodexThreadSummary[]>;
  resumeThread?(threadId: string, options?: SessionControlOptions): Promise<SessionRef>;
  compactThread?(sessionId: string): Promise<void>;
  archiveThread?(sessionId: string): Promise<void>;
  setCollaborationMode?(sessionId: string, mode: CollaborationModeKind): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  kill(sessionId: string): Promise<void>;
  getRecentLog(sessionId: string, limit: number): Promise<LogEntry[]>;
  events(): AsyncIterable<CodexEvent>;
}
