import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/store/store.js";
import { TelegramPlanController } from "../src/telegram/plan-controller.js";
import type { SessionManager } from "../src/runtime/session-manager.js";
import { AppServerFailure } from "../src/adapters/app-server-failure.js";

afterEach(() => vi.useRealTimers());

function setup(path = ":memory:") {
  const store = new Store(path);
  store.upsertSession({ id: "s", adapter: "appserver", codexThreadId: "t", label: "Plan", cwd: "/tmp", connectionGeneration: 1 }, "idle");
  const sessions = {
    setMode: vi.fn(async () => {}),
    sendToSession: vi.fn(async () => {}),
    newSession: vi.fn(async () => store.upsertSession({ id: "fresh", adapter: "appserver", codexThreadId: "fresh-t", label: "Fresh", cwd: "/tmp", connectionGeneration: 1 }, "idle"))
  };
  const controller = new TelegramPlanController("/tmp", store, sessions as unknown as SessionManager);
  const plan = { sessionId: "s", turnId: "turn", itemId: "plan", text: "Final plan", model: "gpt-test", connectionGeneration: 1 };
  controller.record(plan);
  controller.publish("s", "turn", [10], 20);
  const card = store.dueOutbox().find((entry) => entry.payload.keyboard)!;
  const keyboard = card.payload.keyboard as Array<Array<{ text: string; callback_data: string }>>;
  const token = (index: number) => keyboard[index]![0]!.callback_data.slice(5);
  return { store, sessions, controller, plan, token };
}

describe("proposed plan handoff", () => {
  it("persists final text once and queues full Unicode-safe parts plus a single card", () => {
    const s = setup();
    s.controller.record(s.plan);
    s.controller.publish("s", "turn", [10], 20);
    expect(s.store.dueOutbox()).toHaveLength(2);
    expect(s.store.getTranscript("s").match(/Final plan/g)).toHaveLength(1);
    const long = { ...s.plan, itemId: "long", text: "😀".repeat(4000) };
    s.controller.record(long);
    s.controller.publish("s", "turn", [10], 20);
    const parts = s.store.dueOutbox().filter((row) => row.eventKey.includes(":long:") && !row.payload.keyboard);
    expect(parts).toHaveLength(3);
    expect(parts.map((row) => row.payload.text.split("\n\n")[1]).join("")).toBe(long.text);
    expect(parts.every((row) => row.payload.text.length < 4096)).toBe(true);
    s.store.close();
  });

  it("implements on the originating thread and blocks every competing choice", async () => {
    const s = setup();
    await s.controller.choose(s.token(0), { chatId: 10, userId: 20 });
    expect(s.sessions.setMode).toHaveBeenCalledWith("default", "s");
    expect(s.sessions.sendToSession).toHaveBeenCalledWith("s", "Implement the following plan:\n\nFinal plan");
    for (const index of [0, 1, 2]) await expect(s.controller.choose(s.token(index), { chatId: 10, userId: 20 })).rejects.toThrow();
    expect(s.sessions.sendToSession).toHaveBeenCalledTimes(1);
    s.store.close();
  });

  it("starts a fresh thread with the same workspace/model and preserves the source", async () => {
    const s = setup();
    await s.controller.choose(s.token(1), { chatId: 10, userId: 20 });
    expect(s.sessions.newSession).toHaveBeenCalledWith({ cwd: "/tmp", model: "gpt-test" });
    expect(s.sessions.setMode).toHaveBeenCalledWith("default", "fresh");
    expect(s.sessions.sendToSession).toHaveBeenCalledWith("fresh", expect.stringContaining("Final plan"));
    expect(s.store.getSession("s")?.status).toBe("idle");
    expect(s.store.listSessionChats("fresh")).toEqual([10]);
    s.store.close();
  });

  it("keeps planning with an explicit scoped compose route and no automatic prompt", async () => {
    const s = setup();
    s.store.putInteractionDraft({ actionId: "old", chatId: 10, userId: 20, questionIndex: 1, answers: {}, awaitingText: true });
    expect(await s.controller.choose(s.token(2), { chatId: 10, userId: 20 })).toContain("feedback");
    expect(s.sessions.setMode).toHaveBeenCalledWith("plan", "s");
    expect(s.sessions.sendToSession).not.toHaveBeenCalled();
    expect(s.store.consumeRoutingCompose(10, 20)?.sessionId).toBe("s");
    expect(s.store.getAwaitingInteractionDraft(10, 20)).toBeUndefined();
    s.store.close();
  });

  it.each(["chat", "user", "expired", "active", "detached", "paused", "generation", "new-plan", "missing"])("rejects %s controls before an RPC", async (state) => {
    const s = setup();
    if (state === "expired") { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 11 * 60_000); }
    if (state === "active") s.store.setActiveTurn("s", "other");
    if (state === "detached") s.store.markThreadDetached("s");
    if (state === "paused") s.store.setPaused("s", true);
    if (state === "generation") s.store.upsertSession({ ...s.store.getSession("s")!, connectionGeneration: 2 }, "idle");
    if (state === "new-plan") s.controller.record({ ...s.plan, itemId: "new" });
    if (state === "missing") s.store.forgetThread("s");
    await expect(s.controller.choose(s.token(0), { chatId: state === "chat" ? 11 : 10, userId: state === "user" ? 21 : 20 })).rejects.toThrow();
    expect(s.sessions.setMode).not.toHaveBeenCalled();
    expect(s.sessions.sendToSession).not.toHaveBeenCalled();
    s.store.close();
  });

  it("rejects workspace escape before creating a fresh thread", async () => {
    const s = setup();
    const controller = new TelegramPlanController("/tmp/narrow-missing-root", s.store, s.sessions as unknown as SessionManager);
    await expect(controller.choose(s.token(1), { chatId: 10, userId: 20 })).rejects.toThrow(/Workspace root/);
    expect(s.sessions.newSession).not.toHaveBeenCalled();
    s.store.close();
  });

  it.each(["mode", "send"])("does not replay after a %s timeout", async (phase) => {
    const s = setup();
    const method = phase === "mode" ? s.sessions.setMode : s.sessions.sendToSession;
    method.mockRejectedValueOnce(new Error("RPC timeout"));
    await expect(s.controller.choose(s.token(0), { chatId: 10, userId: 20 })).rejects.toThrow(/could not be confirmed.*not be replayed/);
    await expect(s.controller.choose(s.token(0), { chatId: 10, userId: 20 })).rejects.toThrow(/used/);
    await expect(s.controller.choose(s.token(1), { chatId: 10, userId: 20 })).rejects.toThrow(/used/);
    expect(method).toHaveBeenCalledTimes(1);
    s.store.close();
  });

  it("does not steer implementation into a turn started during mode selection", async () => {
    const s = setup();
    s.sessions.setMode.mockImplementationOnce(async () => { s.store.setActiveTurn("s", "racing-turn"); });
    await expect(s.controller.choose(s.token(0), { chatId: 10, userId: 20 })).rejects.toThrow(/could not be confirmed/);
    expect(s.sessions.sendToSession).not.toHaveBeenCalled();
    s.store.close();
  });

  it("serializes concurrent choices before starting any implementation", async () => {
    const s = setup();
    const results = await Promise.allSettled([0, 2].map((index) => s.controller.choose(s.token(index), { chatId: 10, userId: 20 })));
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(s.sessions.setMode).toHaveBeenCalledTimes(1);
    s.store.close();
  });

  it("retains undelivered plans across restart but never reuses their attachment", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "tele-codex-plan-")), "store.db");
    const s = setup(path);
    const token = s.token(0);
    s.store.close();
    const reopened = new Store(path);
    const controller = new TelegramPlanController("/tmp", reopened, s.sessions as unknown as SessionManager);
    expect(reopened.dueOutbox()).toHaveLength(2);
    expect(reopened.proposedPlans.get("s")?.text).toBe("Final plan");
    await expect(controller.choose(token, { chatId: 10, userId: 20 })).rejects.toThrow();
    expect(s.sessions.sendToSession).not.toHaveBeenCalled();
    reopened.close();
  });

  it.each(["missing_connection", "transport_loss", "timeout"] as const)("reports %s without releasing an uncertain action", async (kind) => {
    const s = setup();
    s.sessions.setMode.mockRejectedValueOnce(new AppServerFailure(kind, "private details must not be copied"));
    await expect(s.controller.choose(s.token(0), { chatId: 10, userId: 20 })).rejects.toThrow(kind.replaceAll("_", " "));
    expect(s.store.proposedPlans.get("s")?.used).toBe(true);
    expect(s.sessions.sendToSession).not.toHaveBeenCalled();
    s.store.close();
  });

  it("persists a claimed action across restart without replaying it", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "tele-codex-plan-claim-")), "store.db");
    const s = setup(path);
    s.sessions.sendToSession.mockRejectedValueOnce(new Error("timeout"));
    await expect(s.controller.choose(s.token(0), { chatId: 10, userId: 20 })).rejects.toThrow();
    s.store.close();
    const reopened = new Store(path);
    expect(reopened.proposedPlans.get("s")?.used).toBe(true);
    expect(s.sessions.sendToSession).toHaveBeenCalledTimes(1);
    reopened.close();
  });

  it("removes plan content when Transcript retention is requested", () => {
    const s = setup();
    s.store.maintain({ now: Date.now() + 10_000, transcriptRetentionMs: 1_000 });
    expect(s.store.proposedPlans.get("s")).toBeUndefined();
    s.store.close();
  });

  it("binds delayed completion cards to the version at completion, not a later idle turn", async () => {
    const s = setup();
    const version = s.store.getSessionResourceVersion("s")!;
    s.controller.record({ ...s.plan, itemId: "next-plan" });
    s.store.setActiveTurn("s", "later");
    s.store.setActiveTurn("s", null, "idle");
    s.controller.publish("s", "turn", [10], 20, version);
    const card = s.store.dueOutbox().filter((row) => row.payload.keyboard).at(-1)!;
    const keyboard = card.payload.keyboard as Array<Array<{ callback_data: string }>>;
    await expect(s.controller.choose(keyboard[0]![0]!.callback_data.slice(5), { chatId: 10, userId: 20 })).rejects.toThrow(/changed/);
    expect(s.sessions.sendToSession).not.toHaveBeenCalled();
    s.store.close();
  });
});
