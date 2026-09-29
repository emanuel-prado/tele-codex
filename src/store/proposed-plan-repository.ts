import type Database from "better-sqlite3";
import type { ProposedPlan } from "../types/events.js";

export interface StoredProposedPlan extends ProposedPlan {
  ready: boolean;
  used: boolean;
}

/** One latest proposed plan per thread; content follows Transcript privacy rules. */
export class ProposedPlanRepository {
  constructor(private readonly db: Database.Database) {}

  get(sessionId: string): StoredProposedPlan | undefined {
    const row = this.db.prepare("select data, ready, used from proposed_plans where session_id = ?")
      .get(sessionId) as { data: string; ready: number; used: number } | undefined;
    return row ? { ...JSON.parse(row.data) as ProposedPlan, ready: row.ready === 1, used: row.used === 1 } : undefined;
  }

  record(plan: ProposedPlan, appendTranscript: () => void): void {
    this.db.transaction(() => {
      const previous = this.get(plan.sessionId);
      if (previous?.turnId === plan.turnId && previous.itemId === plan.itemId) return;
      this.db.prepare(`insert into proposed_plans (session_id, data, ready, used, recorded_at) values (?, ?, 0, 0, ?)
        on conflict(session_id) do update set data=excluded.data, ready=0, used=0, recorded_at=excluded.recorded_at`)
        .run(plan.sessionId, JSON.stringify(plan), Date.now());
      appendTranscript();
    })();
  }

  publish(sessionId: string, turnId: string, enqueue: (plan: ProposedPlan) => void): boolean {
    return this.db.transaction(() => {
      const plan = this.get(sessionId);
      if (!plan || plan.turnId !== turnId) return false;
      if (!plan.ready) {
        enqueue(plan);
        this.db.prepare("update proposed_plans set ready = 1 where session_id = ?").run(sessionId);
      }
      return true;
    })();
  }

  claim(sessionId: string, turnId: string, itemId: string): boolean {
    return this.db.transaction(() => {
      const plan = this.get(sessionId);
      if (!plan || plan.turnId !== turnId || plan.itemId !== itemId || !plan.ready || plan.used) return false;
      return this.db.prepare("update proposed_plans set used = 1 where session_id = ? and used = 0").run(sessionId).changes === 1;
    })();
  }
}
