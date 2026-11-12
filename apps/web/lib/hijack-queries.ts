import {
  type HijackLiveSummary,
  HijackOutcome,
  summarizeHijackAttempts,
} from '@twokey/core/hijack';
import { hijackAttempts, payments, proposals } from '@twokey/db';
import { and, count, desc, eq, isNotNull } from 'drizzle-orm';
import { db } from './db';
import { getRedactor } from './episodes-queries';
import { DECISION_LABEL, publicAttemptText } from './hijack-view';

export interface JudgeAttemptRow {
  id: string;
  createdAt: string;
  /** Redacted (brands, URLs, emails, long numbers) and cut short. Plain text. */
  text: string;
  mode: 'live' | 'replay';
  status: 'running' | 'done' | 'replayed' | 'failed';
  followed: boolean | null;
  /** "Blocked · GiftVault", one per proposal; empty when nothing was proposed. */
  decisions: string[];
  attackerCents: number;
}

export interface JudgeAttacksSummary extends HijackLiveSummary {
  rows: JudgeAttemptRow[];
}

export const JUDGE_ROWS_SHOWN = 50;

/** PayPal orders per hijack session: payments that carry a PayPal order ID. */
async function ordersBySession(): Promise<Map<string, number>> {
  const rows = await db()
    .select({ sessionId: proposals.sessionId, n: count() })
    .from(hijackAttempts)
    .innerJoin(proposals, eq(proposals.sessionId, hijackAttempts.sessionId))
    .innerJoin(payments, eq(payments.proposalId, proposals.id))
    .where(and(isNotNull(hijackAttempts.sessionId), isNotNull(payments.paypalOrderId)))
    .groupBy(proposals.sessionId);
  return new Map(rows.map((r) => [r.sessionId, r.n]));
}

/**
 * The judge-written attacks dataset: every hijack box attempt. Separate from the evaluation and
 * never mixed into its numbers; replays show recorded evaluation runs, so they are counted apart.
 */
export async function getJudgeAttacks(): Promise<JudgeAttacksSummary> {
  const [rows, orders] = await Promise.all([
    db()
      .select({
        id: hijackAttempts.id,
        createdAt: hijackAttempts.createdAt,
        text: hijackAttempts.injectionText,
        mode: hijackAttempts.mode,
        status: hijackAttempts.status,
        outcome: hijackAttempts.outcome,
        sessionId: hijackAttempts.sessionId,
      })
      .from(hijackAttempts)
      .orderBy(desc(hijackAttempts.createdAt)),
    ordersBySession(),
  ]);
  const summary = summarizeHijackAttempts(
    rows.map((r) => ({
      status: r.status,
      outcome: r.outcome,
      paypalOrders: r.sessionId ? (orders.get(r.sessionId) ?? 0) : 0,
    })),
  );
  const redact = await getRedactor();
  const out: JudgeAttemptRow[] = [];
  for (const r of rows.slice(0, JUDGE_ROWS_SHOWN)) {
    const parsed = HijackOutcome.safeParse(r.outcome);
    const live = r.status === 'done' && parsed.success ? parsed.data : null;
    out.push({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      text: publicAttemptText(redact(r.text)),
      mode: r.mode === 'replay' ? 'replay' : 'live',
      status: r.status,
      followed: live ? live.followed : null,
      decisions: live
        ? live.proposals.map((p) => `${DECISION_LABEL[p.decision]} · ${p.store}`)
        : [],
      attackerCents: live ? live.attackerCents : 0,
    });
  }
  return { ...summary, rows: out };
}
