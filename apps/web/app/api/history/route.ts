import { createLogger } from '@twokey/core';
import {
  agentSessions,
  gateDecisions,
  listings,
  merchants,
  paymentEvents,
  payments,
  proposals,
} from '@twokey/db';
import { and, desc, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { webEnv } from '@/lib/env';
import {
  type HistoryEvent,
  type HistoryRow,
  type HistoryState,
  ruleChips,
} from '@/lib/history-view';

const MAX_ROWS = 500;
const EVENTS_PER_PAYMENT = 20;

function errorBody(code: string, message: string, status: number) {
  return Response.json({ error: { code, message, requestId: crypto.randomUUID() } }, { status });
}

/**
 * The signed-in user's purchase audit log, newest first: every proposal (eval sessions
 * excluded) with its Two-Key decision, PayPal payment and the latest payment events. Selects no
 * vault or payment-token IDs and no raw event payloads.
 */
export async function GET() {
  const session = await auth();
  if (!session?.userId) return errorBody('UNAUTHENTICATED', 'Sign in first', 401);
  const userId = session.userId;

  try {
    const rows = await db()
      .select({
        proposalId: proposals.id,
        createdAt: proposals.createdAt,
        product: listings.title,
        store: merchants.displayName,
        qty: proposals.qty,
        amountCents: proposals.resolvedAmountCents,
        decision: gateDecisions.outcome,
        ruleHits: gateDecisions.ruleHits,
        paymentId: payments.id,
        state: payments.state,
        orderId: payments.paypalOrderId,
        authorizationId: payments.paypalAuthorizationId,
        captureId: payments.paypalCaptureId,
        updatedAt: payments.updatedAt,
      })
      .from(proposals)
      .innerJoin(agentSessions, eq(agentSessions.id, proposals.sessionId))
      .innerJoin(listings, eq(listings.id, proposals.listingId))
      .innerJoin(merchants, eq(merchants.id, proposals.resolvedMerchantId))
      .leftJoin(
        gateDecisions,
        and(eq(gateDecisions.proposalId, proposals.id), eq(gateDecisions.gate, 'G4')),
      )
      .leftJoin(payments, eq(payments.proposalId, proposals.id))
      .where(and(eq(agentSessions.userId, userId), ne(agentSessions.mode, 'eval')))
      .orderBy(desc(proposals.createdAt))
      .limit(MAX_ROWS);

    const paymentIds = rows.flatMap((r) => (r.paymentId ? [r.paymentId] : []));
    const events = new Map<string, HistoryEvent[]>();
    if (paymentIds.length > 0) {
      const ranked = db()
        .select({
          id: paymentEvents.id,
          paymentId: paymentEvents.paymentId,
          receivedAt: paymentEvents.receivedAt,
          source: paymentEvents.source,
          type: paymentEvents.type,
          fromState: paymentEvents.fromState,
          toState: paymentEvents.toState,
          paypalEventId: paymentEvents.paypalEventId,
          rn: sql<number>`row_number() over (partition by ${paymentEvents.paymentId} order by ${paymentEvents.receivedAt} desc, ${paymentEvents.id} desc)`.as(
            'rn',
          ),
        })
        .from(paymentEvents)
        .where(inArray(paymentEvents.paymentId, paymentIds))
        .as('ranked');
      const latest = await db()
        .select()
        .from(ranked)
        .where(lte(ranked.rn, EVENTS_PER_PAYMENT))
        .orderBy(ranked.receivedAt, ranked.id);
      for (const e of latest) {
        const list = events.get(e.paymentId) ?? [];
        list.push({
          id: e.id,
          at: e.receivedAt.toISOString(),
          source: e.source,
          type: e.type,
          from: e.fromState,
          to: e.toState,
          paypalEventId: e.paypalEventId,
        });
        events.set(e.paymentId, list);
      }
    }

    const out: HistoryRow[] = rows.map((r) => {
      const timeline = r.paymentId ? (events.get(r.paymentId) ?? []) : [];
      const state: HistoryState = r.state ?? (r.decision === 'block' ? 'blocked' : 'failed');
      return {
        proposalId: r.proposalId,
        createdAt: r.createdAt.toISOString(),
        product: r.product,
        store: r.store,
        qty: r.qty,
        amountCents: r.amountCents,
        decision: r.decision,
        ruleHits: ruleChips(r.ruleHits),
        state,
        paymentId: r.paymentId,
        orderId: r.orderId,
        authorizationId: r.authorizationId,
        captureId: r.captureId,
        lastSource: timeline.at(-1)?.source ?? null,
        lastChangeAt: (r.updatedAt ?? r.createdAt).toISOString(),
        buyerPresent: false,
        events: timeline,
      };
    });
    return Response.json({ rows: out }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    // Type only: database errors carry SQL params.
    createLogger('web', webEnv().LOG_LEVEL).error(
      { err: { type: (err as Error)?.name ?? 'Error' } },
      'history query failed',
    );
    return errorBody('INTERNAL', 'Internal error', 500);
  }
}
