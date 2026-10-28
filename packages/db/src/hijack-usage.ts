import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { hijackAttempts } from './schema/index.js';

/** Start of today in UTC, the same day boundary as the budget ledger. */
const todayUtc = sql`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`;

export interface HijackUsage {
  /** Live attempts started today (replays don't count). */
  attempts: number;
  /** Model tokens the live hijack runs used today. */
  tokens: number;
}

/** Today's hijack usage; the daily caps (HIJACK_DAILY_ATTEMPTS / _TOKENS) compare against it. */
export async function hijackUsageToday(db: Db): Promise<HijackUsage> {
  const [row] = await db
    .select({
      attempts: sql<number>`count(*) filter (where ${hijackAttempts.mode} = 'live')::int`,
      tokens: sql<number>`coalesce(sum(${hijackAttempts.tokens}), 0)::int`,
    })
    .from(hijackAttempts)
    .where(gte(hijackAttempts.createdAt, todayUtc as never));
  return { attempts: row?.attempts ?? 0, tokens: row?.tokens ?? 0 };
}

/** The attempt for a hijack session, if any. */
export async function hijackAttemptForSession(db: Db, sessionId: string) {
  const [row] = await db
    .select()
    .from(hijackAttempts)
    .where(and(eq(hijackAttempts.sessionId, sessionId)))
    .limit(1);
  return row;
}
