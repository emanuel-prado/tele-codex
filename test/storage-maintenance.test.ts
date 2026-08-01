import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateDatabase, MigrationError } from "../src/store/migrations.js";
import { NotificationOutboxRepository, TranscriptLogRepository } from "../src/store/repositories.js";
import { Store } from "../src/store/store.js";
import type { PendingAction } from "../src/types/events.js";

describe("versioned SQLite storage", () => {
  it("records ordered migrations and rolls a failed migration back with context", () => {
    const db = new Database(":memory:");
    expect(() => migrateDatabase(db, [
      { version: 1, name: "first", up: (connection) => connection.exec("create table probe (value text); insert into probe values ('kept')") },
      { version: 2, name: "broken", up: (connection) => {
        connection.exec("insert into probe values ('rolled back')");
        throw new Error("invalid transformed row");
      } }
    ])).toThrowError(MigrationError);
    expect(() => migrateDatabase(db, [
      { version: 2, name: "broken", up: () => { throw new Error("invalid transformed row"); } }
    ])).toThrow("Database migration 2 (broken) failed; all changes were rolled back");
    expect(db.prepare("select value from probe").all()).toEqual([{ value: "kept" }]);
    expect(db.prepare("select version from schema_migrations").all()).toEqual([{ version: 1 }]);
    db.close();
  });

  it("exposes focused repositories over one independently testable connection", () => {
    const db = new Database(":memory:");
    migrateDatabase(db);
    const notifications = new NotificationOutboxRepository(db);
    const transcripts = new TranscriptLogRepository(db, 10);
    notifications.enqueue("done:1", 10, { text: "done" });
    transcripts.append("session", "hello", { turnId: "turn", itemId: "item" });
    transcripts.append("session", " world", { turnId: "turn", itemId: "item" });

    expect(notifications.due()).toHaveLength(1);
    expect(transcripts.chunkCount("session")).toBe(2);
    expect(transcripts.text("session")).toContain("hello world");
    db.close();
  });

  it("bounds row growth by item chunks rather than raw deltas", () => {
    const store = new Store(":memory:");
    for (let index = 0; index < 1_000; index += 1) {
      store.appendTranscript("session", "x", { turnId: "turn", itemId: "item" });
    }
    expect(store.transcriptChunkCount("session")).toBe(1);
    expect(store.getTranscript("session")).toContain("x".repeat(1_000));
    expect(store.finalizeTranscriptTurn("session", "turn")).toBe(1);
    store.close();
  });

  it("removes stale operational data without deleting unresolved interactions or undelivered notifications", () => {
    const store = new Store(":memory:");
    const now = Date.now();
    store.putPendingAction(action("unresolved", now - 1));
    store.putCallbackToken({
      token: "active-control", actionId: "unresolved", chatId: 1, operation: "approve", payload: {}, expiresAt: now - 1
    });
    store.putPendingAction(action("delivering", now + 60_000));
    store.resolvePendingAction("delivering", "resolved");
    store.enqueueOutbox("action:delivering", 1, { text: "important" }, "delivering");
    store.appendLog({ sessionId: "session", timestamp: 1, type: "old", severity: "info", text: "old" });
    store.appendTranscript("session", "old transcript");

    const result = store.maintain({
      now: now + 1_000,
      consumedCallbackRetentionMs: 0,
      completedInteractionRetentionMs: 0,
      sentOutboxRetentionMs: 0,
      logRetentionMs: 0,
      transcriptRetentionMs: 0
    });

    expect(result.logs).toBe(1);
    expect(result.transcripts).toBe(1);
    expect(store.getPendingAction("unresolved")).toBeDefined();
    expect(store.getPendingAction("delivering")).toBeDefined();
    expect(store.claimCallbackToken("active-control", 1, undefined, "claim")).toBeUndefined();
    expect(store.dueOutbox()).toHaveLength(1);
    expect(store.diagnostics()).toMatchObject({ schemaVersion: 4, walBytes: 0 });
    store.close();
  });
});

function action(id: string, expiresAt: number): PendingAction {
  return {
    id, kind: "commandApproval", sessionId: "session", requestId: id, title: "Approval",
    body: "run", payload: {}, nonce: id, expiresAt
  };
}
