import { listWorkspaceProjects, type WorkspaceProject } from "../runtime/workspace.js";
import type { CallbackToken, Store, StoredSession } from "../store/store.js";
import type { BackgroundTerminalSummary, CodexModelSummary, CodexThreadSummary } from "../types/control.js";
import type { SessionRef } from "../types/events.js";
import { assertCallbackResource, TelegramCallbackController, type CallbackScope } from "./callback-controller.js";

const PROJECT_OPERATION = "select-workspace-project";
const THREAD_OPERATION = "resume-codex-thread";
const MODEL_OPERATION = "select-session-model";
const PROCESS_OPERATION = "select-background-process";
const CONFIRM_PROCESS_OPERATION = "confirm-background-process";

interface ProjectPayload {
  name: string;
  path: string;
  expectedVersion: number;
}

interface ThreadPayload {
  threadId: string;
  expectedVersion: number;
}

interface ModelPayload {
  modelId: string;
  sessionId: string;
  expectedVersion: number;
}

export interface ProcessSelection {
  sessionId: string;
  processId: string;
  command: string;
  expectedVersion: number;
}

interface PickerServices {
  getActiveSession(): StoredSession | undefined;
  listRemoteThreads(limit?: number): Promise<CodexThreadSummary[]>;
  resumeThread(threadId: string): Promise<StoredSession | SessionRef>;
  listModels(limit?: number): Promise<CodexModelSummary[]>;
  setModel(model: string, sessionId?: string): Promise<void>;
  backgroundTerminals(sessionId?: string): Promise<BackgroundTerminalSummary[]>;
  terminateBackgroundTerminal(processId: string, sessionId?: string): Promise<boolean>;
}

export class TelegramPickerController {
  private readonly callbacks: TelegramCallbackController;

  constructor(
    private readonly workspaceRoot: string,
    private readonly store: Store,
    private readonly sessions: PickerServices,
    callbacks = new TelegramCallbackController(store),
    private readonly projects: (root: string, limit?: number) => Promise<WorkspaceProject[]> = listWorkspaceProjects
  ) {
    this.callbacks = callbacks;
  }

  projectToken(scope: CallbackScope, project: WorkspaceProject): string {
    return this.callbacks.issue({
      ...scope,
      actionId: project.path,
      resourceKind: "workspace-project",
      expectedVersion: project.updatedAt,
      operation: PROJECT_OPERATION,
      payload: { name: project.name, path: project.path, expectedVersion: project.updatedAt } satisfies ProjectPayload
    });
  }

  selectProject(token: string, scope: CallbackScope): Promise<WorkspaceProject> {
    return this.callbacks.execute(token, scope, PROJECT_OPERATION, async (callback) => {
      const payload = callback.payload as Partial<ProjectPayload>;
      if (typeof payload.path !== "string" || typeof payload.expectedVersion !== "number") {
        throw new Error("This project control is invalid. Run /new again.");
      }
      assertCallbackResource(callback, "workspace-project", payload.path, payload.expectedVersion);
      const current = (await this.projects(this.workspaceRoot, 100)).find((project) => project.path === payload.path);
      if (!current || current.name !== payload.name || current.updatedAt !== payload.expectedVersion) {
        throw new Error("This project changed or is no longer available. Run /new again.");
      }
      return current;
    });
  }

  threadToken(scope: CallbackScope, thread: CodexThreadSummary): string {
    return this.callbacks.issue({
      ...scope,
      actionId: thread.id,
      resourceKind: "codex-thread",
      expectedVersion: thread.updatedAt ?? 0,
      operation: THREAD_OPERATION,
      payload: { threadId: thread.id, expectedVersion: thread.updatedAt ?? 0 } satisfies ThreadPayload
    });
  }

  selectThread(token: string, scope: CallbackScope): Promise<StoredSession | SessionRef> {
    return this.callbacks.execute(token, scope, THREAD_OPERATION, async (callback) => {
      const payload = callback.payload as Partial<ThreadPayload>;
      if (typeof payload.threadId !== "string" || typeof payload.expectedVersion !== "number") {
        throw new Error("This thread control is invalid. Run /resume again.");
      }
      assertCallbackResource(callback, "codex-thread", payload.threadId, payload.expectedVersion);
      const current = (await this.sessions.listRemoteThreads(25)).find((thread) => thread.id === payload.threadId);
      if (!current || (current.updatedAt ?? 0) !== payload.expectedVersion) {
        throw new Error("This thread changed or is no longer available. Run /resume again.");
      }
      return this.sessions.resumeThread(current.id);
    });
  }

  modelToken(scope: CallbackScope, model: CodexModelSummary, session: StoredSession): string {
    return this.callbacks.issue({
      ...scope,
      actionId: session.id,
      resourceKind: "session",
      expectedVersion: this.resourceVersion(session.id),
      operation: MODEL_OPERATION,
      payload: {
        modelId: model.id,
        sessionId: session.id,
        expectedVersion: this.resourceVersion(session.id)
      } satisfies ModelPayload
    });
  }

  selectModel(token: string, scope: CallbackScope): Promise<string> {
    return this.callbacks.execute(token, scope, MODEL_OPERATION, async (callback) => {
      const payload = callback.payload as Partial<ModelPayload>;
      if (typeof payload.modelId !== "string" || typeof payload.sessionId !== "string" || typeof payload.expectedVersion !== "number") {
        throw new Error("This model control is invalid. Run /model again.");
      }
      assertCallbackResource(callback, "session", payload.sessionId, payload.expectedVersion);
      const active = this.sessions.getActiveSession();
      if (!active || active.id !== payload.sessionId || this.resourceVersion(active.id) !== payload.expectedVersion) {
        throw new Error("The active session changed after this picker opened. Run /model again.");
      }
      const model = (await this.sessions.listModels(100)).find((candidate) => candidate.id === payload.modelId);
      if (!model) throw new Error("This model is no longer available. Run /model again.");
      await this.sessions.setModel(model.id, active.id);
      return model.id;
    });
  }

  processToken(scope: CallbackScope, session: StoredSession, process: BackgroundTerminalSummary): string {
    return this.issueProcess(scope, PROCESS_OPERATION, {
      sessionId: session.id,
      processId: process.processId,
      command: process.command,
      expectedVersion: this.resourceVersion(session.id)
    });
  }

  async selectProcess(token: string, scope: CallbackScope): Promise<{ selection: ProcessSelection; confirmationToken: string }> {
    const selection = await this.callbacks.execute(token, scope, PROCESS_OPERATION, (callback) => this.validateProcessControl(callback));
    return { selection, confirmationToken: this.issueProcess(scope, CONFIRM_PROCESS_OPERATION, selection) };
  }

  terminateProcess(token: string, scope: CallbackScope): Promise<boolean> {
    return this.callbacks.execute(token, scope, CONFIRM_PROCESS_OPERATION, async (callback) => {
      const selection = await this.validateProcessControl(callback);
      return this.sessions.terminateBackgroundTerminal(selection.processId, selection.sessionId);
    });
  }

  private issueProcess(scope: CallbackScope, operation: string, payload: ProcessSelection): string {
    return this.callbacks.issue({
      ...scope,
      actionId: payload.processId,
      resourceKind: "background-process",
      expectedVersion: payload.expectedVersion,
      operation,
      payload
    });
  }

  private async validateProcess(raw: unknown): Promise<ProcessSelection> {
    const payload = raw as Partial<ProcessSelection>;
    if (
      typeof payload.sessionId !== "string" || typeof payload.processId !== "string" ||
      typeof payload.command !== "string" || typeof payload.expectedVersion !== "number"
    ) {
      throw new Error("This process control is invalid. Run /processes again.");
    }
    if (this.resourceVersion(payload.sessionId) !== payload.expectedVersion) {
      throw new Error("The session changed after this process picker opened. Run /processes again.");
    }
    const current = (await this.sessions.backgroundTerminals(payload.sessionId))
      .find((process) => process.processId === payload.processId && process.command === payload.command);
    if (!current) throw new Error("This background process is no longer running.");
    return payload as ProcessSelection;
  }

  private async validateProcessControl(callback: CallbackToken): Promise<ProcessSelection> {
    const selection = await this.validateProcess(callback.payload);
    assertCallbackResource(callback, "background-process", selection.processId, selection.expectedVersion);
    return selection;
  }

  private resourceVersion(sessionId: string): number {
    const version = this.store.getSessionResourceVersion(sessionId);
    if (version === undefined) throw new Error("The selected session no longer exists.");
    return version;
  }
}

export type { PickerServices };
