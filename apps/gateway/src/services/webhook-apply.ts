import { canTransition, webhookTarget } from '@twokey/core';
import {
  agentSessions,
  type Db,
  paymentEvents,
  payments,
  proposals,
  webhookEvents,
} from '@twokey/db';
import { and, asc, eq, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

export type WebhookEventRow = typeof webhookEvents.$inferSelect;
export type ApplyResult = 'applied' | 'stale' | 'no_payment' | 'ignored';
type Logger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

/** After this many attempts an event for an unknown payment stops being retried. */
export const MAX_WEBHOOK_ATTEMPTS = 60;
export const NOTIFY_CHANNEL = 'twokey_events';

function field(v: unknown, ...path: string[]): string {
  let cur = v;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' ? cur : '';
}

/** Which payment an event belongs to, or null when the event carries no usable ID. */
function paymentMatch(eventType: string, resource: unknown): SQL | null {
  const resourceId = field(resource, 'id');
  if (eventType.startsWith('PAYMENT.AUTHORIZATION.')) {
    return resourceId ? eq(payments.paypalAuthorizationId, resourceId) : null;
  }
  if (eventType.startsWith('PAYMENT.CAPTURE.')) {
    const authorizationId = field(
      resource,
      'supplementary_data',
      'related_ids',
      'authorization_id',
    );
    const conds = [
      authorizationId ? eq(payments.paypalAuthorizationId, authorizationId) : undefined,
      resourceId ? eq(payments.paypalCaptureId, resourceId) : undefined,
    ].filter((c): c is SQL => c !== undefined);
    return conds.length ? (or(...conds) ?? null) : null;
  }
  return null;
}

/**
 * Applies one verified webhook event to its payment, forward-only. Late, duplicate and
 * backward events are recorded as `ignored_stale` and never change state.
 */
export async function applyWebhookEvent(db: Db, eventRow: WebhookEventRow): Promise<ApplyResult> {
  const eventId = eventRow.paypalEventId;
  const eventType = eventRow.eventType;
  const resource = (eventRow.raw as { resource?: unknown } | null)?.resource;
  const target = webhookTarget(eventType);
  const match = target ? paymentMatch(eventType, resource) : null;

  return db.transaction(async (tx) => {
    // Lock the event row first so the inline apply and the retry loop never both apply it.
    const [current] = await tx
      .select({ processedAt: webhookEvents.processedAt, verification: webhookEvents.verification })
      .from(webhookEvents)
      .where(eq(webhookEvents.paypalEventId, eventId))
      .for('update');
    if (!current || current.processedAt || current.verification !== 'SUCCESS') return 'ignored';

    const markProcessed = () =>
      tx
        .update(webhookEvents)
        .set({ processedAt: sql`now()`, attempts: sql`${webhookEvents.attempts} + 1` })
        .where(eq(webhookEvents.paypalEventId, eventId));

    if (!target) {
      // VAULT.* and other types are not payment-state events (VAULT.* handled separately).
      await markProcessed();
      return 'ignored';
    }

    const [payment] = match
      ? await tx
          .select({ id: payments.id, state: payments.state, userId: agentSessions.userId })
          .from(payments)
          .innerJoin(proposals, eq(proposals.id, payments.proposalId))
          .innerJoin(agentSessions, eq(agentSessions.id, proposals.sessionId))
          .where(match)
          .limit(1)
          .for('update', { of: payments })
      : [];

    if (!payment) {
      await tx
        .update(webhookEvents)
        .set({ attempts: sql`${webhookEvents.attempts} + 1` })
        .where(eq(webhookEvents.paypalEventId, eventId));
      return 'no_payment';
    }

    const payload = {
      eventType,
      resourceId: field(resource, 'id'),
      resourceStatus: field(resource, 'status'),
    };

    if (!canTransition(payment.state, target)) {
      await tx.insert(paymentEvents).values({
        paymentId: payment.id,
        source: 'webhook',
        type: 'ignored_stale',
        fromState: payment.state,
        toState: payment.state,
        paypalEventId: eventId,
        payload: { ...payload, target },
      });
      await markProcessed();
      return 'stale';
    }

    const captureId = eventType.startsWith('PAYMENT.CAPTURE.') ? field(resource, 'id') : '';
    await tx
      .update(payments)
      .set({
        state: target,
        updatedAt: sql`now()`,
        ...(captureId ? { paypalCaptureId: captureId } : {}),
      })
      .where(eq(payments.id, payment.id));
    await tx.insert(paymentEvents).values({
      paymentId: payment.id,
      source: 'webhook',
      type: eventType,
      fromState: payment.state,
      toState: target,
      paypalEventId: eventId,
      payload,
    });
    await markProcessed();
    const notice = {
      type: 'payment.updated',
      userId: payment.userId,
      paymentId: payment.id,
      state: target,
    };
    await tx.execute(sql`select pg_notify(${NOTIFY_CHANNEL}, ${JSON.stringify(notice)})`);
    return 'applied';
  });
}

/** Retries verified events that are not processed yet (usually: payment row not written yet). */
export async function processPendingWebhooks(
  db: Db,
  logger: Logger,
): Promise<Record<ApplyResult, number>> {
  const counts: Record<ApplyResult, number> = { applied: 0, stale: 0, no_payment: 0, ignored: 0 };
  const pending = await db
    .select()
    .from(webhookEvents)
    .where(
      and(
        isNull(webhookEvents.processedAt),
        eq(webhookEvents.verification, 'SUCCESS'),
        lt(webhookEvents.attempts, MAX_WEBHOOK_ATTEMPTS),
      ),
    )
    .orderBy(asc(webhookEvents.receivedAt))
    .limit(100);

  for (const row of pending) {
    const log = {
      eventId: row.paypalEventId,
      eventType: row.eventType,
      resourceId: row.resourceId,
    };
    try {
      const result = await applyWebhookEvent(db, row);
      counts[result] += 1;
      if (result !== 'no_payment')
        logger.info({ ...log, result }, 'paypal webhook applied (retry)');
      else if (row.attempts + 1 >= MAX_WEBHOOK_ATTEMPTS) {
        logger.warn(log, 'paypal webhook gave up: no matching payment');
      }
    } catch (err) {
      logger.error({ ...log, err }, 'paypal webhook retry failed');
    }
  }
  return counts;
}
