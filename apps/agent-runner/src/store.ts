import { agentSessions, type BudgetScope, type Db, proposals, spend } from '@twokey/db';
import { and, eq, sql } from 'drizzle-orm';
import type { TranscriptEntry } from './run-session.js';

export const EVENTS_CHANNEL = 'twokey_events';

/** Everything runSession writes. Tests swap in a fake; production uses createDbStore. */
export interface RunStore {
  spend(scope: BudgetScope, usd: number, capUsd: number): Promise<void>;
  notify(payload: Record<string, unknown>): Promise<void>;
  setReasoning(sessionId: string, proposalId: string, excerpt: string): Promise<void>;
  finish(i: {
    sessionId: string;
    status: 'ended' | 'failed';
    transcript: TranscriptEntry[];
  }): Promise<void>;
}

export function createDbStore(db: Db): RunStore {
  return {
    spend: (scope, usd, capUsd) => spend(db, scope, usd, capUsd),
    async notify(payload) {
      await db.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(payload)})`);
    },
    async setReasoning(sessionId, proposalId, excerpt) {
      await db
        .update(proposals)
        .set({ agentReasoningExcerpt: excerpt })
        .where(and(eq(proposals.id, proposalId), eq(proposals.sessionId, sessionId)));
    },
    async finish({ sessionId, status, transcript }) {
      await db
        .update(agentSessions)
        .set({ status, transcript, endedAt: sql`now()` })
        .where(eq(agentSessions.id, sessionId));
    },
  };
}
