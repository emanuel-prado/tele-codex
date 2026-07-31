import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store, type StoredSession } from "../src/store/store.js";
import { TelegramCallbackController } from "../src/telegram/callback-controller.js";
import { TelegramPickerController, type PickerServices } from "../src/telegram/picker-controller.js";
import type { BackgroundTerminalSummary, CodexModelSummary, CodexThreadSummary } from "../src/types/control.js";

describe("TelegramCallbackController", () => {
  it("releases a failed claim for retry and commits a successful callback exactly once", async () => {
    const store = new Store(":memory:");
    const controller = new TelegramCallbackController(store);
    const token = controller.issue({
      chatId: 10,
      userId: 20,
      actionId: "action_1",
      operation: "test",
      payload: { value: 1 }
    });

    await expect(controller.execute(token, { chatId: 10, userId: 20 }, "test", () => {
      throw new Error("transient");
    })).rejects.toThrow("transient");
    await expect(controller.execute(token, { chatId: 10, userId: 20 }, "test", (callback) => callback.payload)).resolves.toEqual({ value: 1 });
    await expect(controller.execute(token, { chatId: 10, userId: 20 }, "test", () => undefined)).rejects.toThrow(/already used/i);
    store.close();
  });

  it("blocks a duplicate claim and releases an interrupted claim after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tele-codex-callback-claim-"));
    const path = join(dir, "state.sqlite");
    const before = new Store(path);
    const controller = new TelegramCallbackController(before);
    const token = controller.issue({ chatId: 10, userId: 20, actionId: "action_1", operation: "test", payload: {} });
    expect(before.claimCallbackToken(token, 10, 20, "abandoned_claim")).toBeDefined();
    expect(before.claimCallbackToken(token, 10, 20, "duplicate_claim")).toBeUndefined();
    before.close();

    const after = new Store(path);
    await expect(new TelegramCallbackController(after).execute(
      token,
      { chatId: 10, userId: 20 },
      "test",
      () => "recovered"
    )).resolves.toBe("recovered");
    after.close();
  });
});

describe("TelegramPickerController", () => {
  it("isolates two simultaneous picker messages and two chats without global invalidation", async () => {
    const fixture = setup();
    const first = { name: "one", path: "/workspace/one", updatedAt: 1 };
    const second = { name: "two", path: "/workspace/two", updatedAt: 2 };
    fixture.projects.push(first, second);
    const firstToken = fixture.controller.projectToken({ chatId: 10, userId: 20 }, first);
    const secondToken = fixture.controller.projectToken({ chatId: 10, userId: 20 }, second);
    const otherChatToken = fixture.controller.projectToken({ chatId: 11, userId: 20 }, first);

    await expect(fixture.controller.selectProject(firstToken, { chatId: 10, userId: 21 })).rejects.toThrow(/another chat or user/i);
    await expect(fixture.controller.selectProject(firstToken, { chatId: 10, userId: 20 })).resolves.toEqual(first);
    await expect(fixture.controller.selectProject(secondToken, { chatId: 10, userId: 20 })).resolves.toEqual(second);
    await expect(fixture.controller.selectProject(otherChatToken, { chatId: 11, userId: 20 })).resolves.toEqual(first);
    fixture.store.close();
  });

  it("keeps a picker valid across a complete store and controller restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tele-codex-picker-restart-"));
    const path = join(dir, "state.sqlite");
    const project = { name: "one", path: "/workspace/one", updatedAt: 1 };
    const before = setup(path);
    before.projects.push(project);
    const token = before.controller.projectToken({ chatId: 10, userId: 20 }, project);
    before.store.close();

    const after = setup(path);
    after.projects.push(project);
    await expect(after.controller.selectProject(token, { chatId: 10, userId: 20 })).resolves.toEqual(project);
    after.store.close();
  });

  it("rejects stale project and process controls with an actionable retry message", async () => {
    const fixture = setup();
    const project = { name: "one", path: "/workspace/one", updatedAt: 1 };
    fixture.projects.push(project);
    const projectToken = fixture.controller.projectToken({ chatId: 10, userId: 20 }, project);
    project.updatedAt = 2;
    await expect(fixture.controller.selectProject(projectToken, { chatId: 10, userId: 20 })).rejects.toThrow(/run \/new again/i);

    const session = fixture.addSession();
    const process = { itemId: "item_1", processId: "proc_1", command: "npm test", cwd: "/workspace/one" };
    fixture.processes.push(process);
    const processToken = fixture.controller.processToken({ chatId: 10, userId: 20 }, session, process);
    fixture.processes.length = 0;
    await expect(fixture.controller.selectProcess(processToken, { chatId: 10, userId: 20 })).rejects.toThrow(/no longer running/i);
    fixture.store.close();
  });

  it("validates thread, model, and process resource state before applying actions", async () => {
    const fixture = setup();
    const session = fixture.addSession();
    const thread: CodexThreadSummary = { id: "thread_2", name: "two", updatedAt: 42 };
    fixture.threads.push(thread);
    fixture.models.push({ id: "model-a", displayName: "A" });
    fixture.processes.push({ itemId: "item_1", processId: "proc_1", command: "npm test", cwd: "/workspace/one" });

    const threadToken = fixture.controller.threadToken({ chatId: 10, userId: 20 }, thread);
    await expect(fixture.controller.selectThread(threadToken, { chatId: 10, userId: 20 })).resolves.toMatchObject({ codexThreadId: "thread_2" });

    const modelToken = fixture.controller.modelToken({ chatId: 10, userId: 20 }, fixture.models[0]!, session);
    await expect(fixture.controller.selectModel(modelToken, { chatId: 10, userId: 20 })).resolves.toBe("model-a");
    expect(fixture.selectedModels).toEqual([{ model: "model-a", sessionId: "session_1" }]);

    const processToken = fixture.controller.processToken({ chatId: 10, userId: 20 }, session, fixture.processes[0]!);
    const selected = await fixture.controller.selectProcess(processToken, { chatId: 10, userId: 20 });
    await expect(fixture.controller.terminateProcess(selected.confirmationToken, { chatId: 10, userId: 20 })).resolves.toBe(true);
    expect(fixture.terminated).toEqual([{ processId: "proc_1", sessionId: "session_1" }]);
    fixture.store.close();
  });
});

function setup(path = ":memory:") {
  const store = new Store(path);
  const projects: Array<{ name: string; path: string; updatedAt: number }> = [];
  const threads: CodexThreadSummary[] = [];
  const models: CodexModelSummary[] = [];
  const processes: BackgroundTerminalSummary[] = [];
  const selectedModels: Array<{ model: string; sessionId?: string }> = [];
  const terminated: Array<{ processId: string; sessionId?: string }> = [];
  const services: PickerServices = {
    getActiveSession: () => store.getSession("session_1"),
    async listRemoteThreads() { return threads; },
    async resumeThread(threadId) {
      return store.upsertSession({ id: `session_${threadId}`, adapter: "appserver", label: threadId, codexThreadId: threadId }, "idle");
    },
    async listModels() { return models; },
    async setModel(model, sessionId) { selectedModels.push(sessionId ? { model, sessionId } : { model }); },
    async backgroundTerminals() { return processes; },
    async terminateBackgroundTerminal(processId, sessionId) {
      terminated.push(sessionId ? { processId, sessionId } : { processId });
      return true;
    }
  };
  return {
    store,
    projects,
    threads,
    models,
    processes,
    selectedModels,
    terminated,
    controller: new TelegramPickerController("/workspace", store, services, undefined, async () => projects),
    addSession(): StoredSession {
      return store.upsertSession({ id: "session_1", adapter: "appserver", label: "one", codexThreadId: "thread_1" }, "idle");
    }
  };
}
