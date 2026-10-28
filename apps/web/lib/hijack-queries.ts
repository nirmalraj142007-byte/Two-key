import { HijackOutcome } from '@twokey/core/hijack';
import { hijackAttempts } from '@twokey/db';
import { desc } from 'drizzle-orm';
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

export interface JudgeAttacksSummary {
  total: number;
  /** Live runs that finished with their own result: the follow rate's denominator. */
  liveFinished: number;
  followed: number;
  replayed: number;
  failed: number;
  outcomes: Record<'captured' | 'held' | 'blocked' | 'failed' | 'recorded', number>;
  attackerCents: number;
  rows: JudgeAttemptRow[];
}

export const JUDGE_ROWS_SHOWN = 50;

/**
 * The judge-written attacks dataset: every hijack box attempt. Separate from the evaluation and
 * never mixed into its numbers; replays show recorded evaluation runs, so they are counted apart.
 */
export async function getJudgeAttacks(): Promise<JudgeAttacksSummary> {
  const rows = await db()
    .select({
      id: hijackAttempts.id,
      createdAt: hijackAttempts.createdAt,
      text: hijackAttempts.injectionText,
      mode: hijackAttempts.mode,
      status: hijackAttempts.status,
      outcome: hijackAttempts.outcome,
    })
    .from(hijackAttempts)
    .orderBy(desc(hijackAttempts.createdAt));
  const redact = await getRedactor();
  const summary: JudgeAttacksSummary = {
    total: rows.length,
    liveFinished: 0,
    followed: 0,
    replayed: 0,
    failed: 0,
    outcomes: { captured: 0, held: 0, blocked: 0, failed: 0, recorded: 0 },
    attackerCents: 0,
    rows: [],
  };
  for (const r of rows) {
    const parsed = HijackOutcome.safeParse(r.outcome);
    const outcome = parsed.success ? parsed.data : null;
    if (r.status === 'replayed') summary.replayed++;
    if (r.status === 'failed') summary.failed++;
    const live = r.status === 'done' && outcome !== null ? outcome : null;
    if (live) {
      summary.liveFinished++;
      if (live.followed) summary.followed++;
      for (const p of live.proposals) summary.outcomes[p.decision]++;
      summary.attackerCents += live.attackerCents;
    }
    if (summary.rows.length < JUDGE_ROWS_SHOWN) {
      summary.rows.push({
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
  }
  return summary;
}
