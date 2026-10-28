import {
  followedInjection,
  type HijackOutcome,
  type HijackProposal,
  type PaymentState,
  RuleCardSchema,
} from '@twokey/core';
import {
  agentSessions,
  type Db,
  gateDecisions,
  hijackAttempts,
  listings,
  merchants,
  payments,
  proposals,
  ruleCards,
} from '@twokey/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { TranscriptEntry } from './run-session.js';

/** Hijack runs never use more than this, even with plenty of the daily allowance left. */
export const HIJACK_RUN_MAX_TOKENS = 40_000;

/** Input + output tokens recorded on a transcript. */
export function transcriptTokens(transcript: readonly TranscriptEntry[]): number {
  return transcript.reduce(
    (n, e) => n + (e.usage ? e.usage.inputTokens + e.usage.outputTokens : 0),
    0,
  );
}

/** The gateway's sentence for a proposal: the first line of its propose_purchase result. */
export function proposalReason(
  transcript: readonly TranscriptEntry[],
  proposalId: string,
): string | undefined {
  const tool = transcript.find(
    (e) =>
      e.role === 'tool' &&
      e.toolName === 'propose_purchase' &&
      e.text.includes(`"proposalId":"${proposalId}"`),
  );
  if (!tool) return undefined;
  const nl = tool.text.indexOf('\n');
  return nl === -1 ? tool.text : tool.text.slice(0, nl);
}

function decisionOf(outcome: string, state: PaymentState | null): HijackProposal['decision'] {
  if (outcome === 'block') return 'blocked';
  switch (state) {
    case 'captured':
    case 'capture_requested':
      return 'captured';
    case 'held':
    case 'void_requested':
    case 'voided':
    case 'denied':
    case 'expired':
      return 'held';
    default:
      return 'failed';
  }
}

const FALLBACK_REASON: Record<HijackProposal['decision'], string> = {
  blocked: 'Blocked by the rules. No PayPal order created.',
  held: 'Held for approval: the price looks unusual.',
  captured: 'Bought within the rules.',
  failed: 'Not purchased.',
  recorded: 'Recorded.',
};

/** The result card for a live hijack run, built from the session's own rows. */
export async function liveOutcome(
  db: Db,
  i: { sessionId: string; model: string; transcript: readonly TranscriptEntry[]; message?: string },
): Promise<HijackOutcome> {
  const [session] = await db
    .select({ rules: ruleCards.rules })
    .from(agentSessions)
    .innerJoin(ruleCards, eq(ruleCards.id, agentSessions.ruleCardId))
    .where(eq(agentSessions.id, i.sessionId))
    .limit(1);
  const card = RuleCardSchema.safeParse(session?.rules);
  const allowed = new Set(card.success ? card.data.allowedMerchantIds : []);
  const capCents = card.success ? card.data.perItemCapCents : 7000;

  const rows = await db
    .select({
      id: proposals.id,
      qty: proposals.qty,
      amountCents: proposals.resolvedAmountCents,
      title: listings.title,
      category: listings.category,
      merchantId: merchants.id,
      store: merchants.displayName,
      role: merchants.role,
      outcome: gateDecisions.outcome,
      state: payments.state,
    })
    .from(proposals)
    .innerJoin(listings, eq(listings.id, proposals.listingId))
    .innerJoin(merchants, eq(merchants.id, proposals.resolvedMerchantId))
    .innerJoin(
      gateDecisions,
      and(eq(gateDecisions.proposalId, proposals.id), eq(gateDecisions.gate, 'G4')),
    )
    .leftJoin(payments, eq(payments.proposalId, proposals.id))
    .where(eq(proposals.sessionId, i.sessionId))
    .orderBy(asc(proposals.createdAt));

  const out: HijackProposal[] = rows.map((r) => {
    const decision = decisionOf(r.outcome, r.state);
    return {
      product: r.title,
      store: r.store,
      amountCents: r.amountCents,
      decision,
      reason: proposalReason(i.transcript, r.id) ?? FALLBACK_REASON[decision],
      attacker: r.role === 'attacker',
    };
  });
  const attackerCents = rows
    .filter(
      (r) => r.role === 'attacker' && (r.state === 'captured' || r.state === 'capture_requested'),
    )
    .reduce((n, r) => n + r.amountCents, 0);

  return {
    status: 'done',
    followed: followedInjection(
      rows.map((r) => ({
        category: r.category,
        qty: r.qty,
        amountCents: r.amountCents,
        allowedStore: allowed.has(r.merchantId),
      })),
      capCents,
    ),
    proposals: out,
    attackerCents,
    model: i.model,
    ...(i.message ? { message: i.message } : {}),
  };
}

/**
 * Records a finished live run. The attempt only becomes 'done' while still 'running': if a replay
 * already took over (the live model was too slow), the live result is kept under `lateLive` and
 * the replay stays what the page shows. Tokens always count toward today's cap.
 * Returns true when the live result is the attempt's result.
 */
export async function finishLiveAttempt(
  db: Db,
  attemptId: string,
  outcome: HijackOutcome,
  tokens: number,
  costUsd: number,
): Promise<boolean> {
  const done = await db
    .update(hijackAttempts)
    .set({ status: 'done', outcome, tokens, costUsd: String(costUsd) })
    .where(and(eq(hijackAttempts.id, attemptId), eq(hijackAttempts.status, 'running')))
    .returning({ id: hijackAttempts.id });
  if (done.length > 0) return true;
  await db
    .update(hijackAttempts)
    .set({
      tokens,
      costUsd: String(costUsd),
      outcome: sql`coalesce(${hijackAttempts.outcome}, '{}'::jsonb) || jsonb_build_object('lateLive', ${JSON.stringify(outcome)}::jsonb)`,
    })
    .where(eq(hijackAttempts.id, attemptId));
  return false;
}

/** Counts a run's tokens toward today's cap without touching its status or result. */
export async function recordAttemptUsage(
  db: Db,
  attemptId: string,
  tokens: number,
  costUsd: number,
): Promise<void> {
  await db
    .update(hijackAttempts)
    .set({ tokens, costUsd: String(costUsd) })
    .where(eq(hijackAttempts.id, attemptId));
}

/** A failed attempt still ends in a result card. */
export function failedOutcome(model: string, message: string): HijackOutcome {
  return { status: 'failed', followed: null, proposals: [], attackerCents: 0, model, message };
}
