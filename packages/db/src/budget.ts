import { AppError, ErrorCode } from '@twokey/core';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { budgetLedger } from './schema/index.js';

export type BudgetScope = 'live' | 'hijack' | 'eval';

const today = sql`(now() at time zone 'utc')::date`;

function exceeded(scope: BudgetScope): AppError {
  return new AppError(ErrorCode.BUDGET_EXCEEDED, `The daily ${scope} AI budget is used up`, {
    httpStatus: 429,
  });
}

/**
 * Adds `usd` to today's spend for `scope`, atomically. Throws BUDGET_EXCEEDED (and stamps
 * tripped_at) when the total would pass `capUsd`. Zero-cost calls are still recorded.
 */
export async function spend(
  db: Db,
  scope: BudgetScope,
  usd: number,
  capUsd: number,
): Promise<void> {
  if (!Number.isFinite(usd) || usd < 0) throw new AppError(ErrorCode.VALIDATION, 'Invalid spend');
  const over = usd > capUsd;
  const rows = over
    ? []
    : await db
        .insert(budgetLedger)
        .values({ day: today, scope, spentUsd: String(usd), capUsd: String(capUsd) })
        .onConflictDoUpdate({
          target: [budgetLedger.day, budgetLedger.scope],
          set: {
            spentUsd: sql`${budgetLedger.spentUsd} + excluded.spent_usd`,
            capUsd: sql`excluded.cap_usd`,
          },
          setWhere: sql`${budgetLedger.spentUsd} + excluded.spent_usd <= excluded.cap_usd`,
        })
        .returning({ spentUsd: budgetLedger.spentUsd });
  if (rows.length > 0) return;

  await db
    .insert(budgetLedger)
    .values({ day: today, scope, spentUsd: '0', capUsd: String(capUsd), trippedAt: sql`now()` })
    .onConflictDoUpdate({
      target: [budgetLedger.day, budgetLedger.scope],
      set: { trippedAt: sql`now()` },
    });
  throw exceeded(scope);
}

/** Dollars left today for `scope` under `capUsd`. */
export async function remaining(db: Db, scope: BudgetScope, capUsd: number): Promise<number> {
  const [row] = await db
    .select({ spentUsd: budgetLedger.spentUsd })
    .from(budgetLedger)
    .where(and(eq(budgetLedger.day, today as never), eq(budgetLedger.scope, scope)))
    .limit(1);
  return Math.max(0, capUsd - Number(row?.spentUsd ?? 0));
}
