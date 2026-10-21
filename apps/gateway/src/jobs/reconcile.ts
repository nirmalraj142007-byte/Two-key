import { canTransition, type PaymentState, TERMINAL } from '@twokey/core';
import { merchants, paymentEvents, payments } from '@twokey/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  type Claimed,
  closeApproval,
  notify,
  paymentOwner,
  sendCapture,
  sendVoid,
  type Via,
} from '../services/settle.js';
import { type JobDeps, scheduleReconcile } from './queue.js';

export type ReconcileResult = 'changed' | 'unchanged' | 'skipped' | 'resent' | 'confirmed';

const AUTHORIZATION_STATUS: Readonly<Record<string, PaymentState>> = {
  CREATED: 'authorized',
  CAPTURED: 'captured',
  PARTIALLY_CAPTURED: 'captured',
  VOIDED: 'voided',
  EXPIRED: 'expired',
  DENIED: 'denied',
  PENDING: 'capture_requested',
};
const CAPTURE_STATUS: Readonly<Record<string, PaymentState>> = { COMPLETED: 'captured' };

/** A capture or void request older than this, with the authorization still open, is resent. */
export const STUCK_MS = 2 * 60 * 1000;

function lookup(table: Readonly<Record<string, PaymentState>>, status: string | undefined) {
  return status && Object.hasOwn(table, status) ? table[status] : undefined;
}

/** How the original capture or void was requested (human channel or timer), from its event. */
async function requestedVia(deps: JobDeps, paymentId: string, kind: 'capture' | 'void') {
  const [row] = await deps.db
    .select({ payload: paymentEvents.payload })
    .from(paymentEvents)
    .where(and(eq(paymentEvents.paymentId, paymentId), eq(paymentEvents.type, `${kind}.requested`)))
    .orderBy(desc(paymentEvents.receivedAt))
    .limit(1);
  const p = row?.payload as { via?: unknown; reason?: unknown } | undefined;
  const via: Via = p?.via === 'web' || p?.via === 'phone' || p?.via === 'timer' ? p.via : 'timer';
  return { via, reason: typeof p?.reason === 'string' ? p.reason : 'resent' };
}

/**
 * payment.reconcile: reads the authorization (and the capture, when there is one) from PayPal
 * and moves the payment forward to match, recording a `reconciler` event only when the state
 * changes. This settles a payment whose webhook never arrived.
 *
 * Crash recovery: a payment left in capture_requested / void_requested for over 2 minutes while
 * PayPal still shows the authorization CREATED gets the SAME request resent, with the ORIGINAL
 * PayPal-Request-Id and the same caller (platform for captures, payee merchant for voids).
 *
 * A voided payment is confirmed once by GET, because the VOIDED webhook for a merchant-credential
 * void goes to the merchant's app, not ours.
 */
export async function reconcilePayment(deps: JobDeps, paymentId: string): Promise<ReconcileResult> {
  const [row] = await deps.db
    .select({
      state: payments.state,
      proposalId: payments.proposalId,
      authorizationId: payments.paypalAuthorizationId,
      captureId: payments.paypalCaptureId,
      updatedAt: payments.updatedAt,
      payeeSlug: merchants.slug,
    })
    .from(payments)
    .innerJoin(merchants, eq(merchants.id, payments.payeeMerchantId))
    .where(eq(payments.id, paymentId))
    .limit(1);
  if (!row) return 'skipped';
  if (row.state === 'voided') return confirmVoid(deps, paymentId, row.authorizationId);
  if (TERMINAL.has(row.state)) return 'skipped';
  if (!row.authorizationId) {
    deps.log.warn({ paymentId, state: row.state }, 'reconcile: payment has no authorization ID');
    return 'skipped';
  }

  const auth = await deps.paypal.getAuthorization(row.authorizationId);
  const now = deps.now?.() ?? new Date();

  if (
    auth.status === 'CREATED' &&
    (row.state === 'capture_requested' || row.state === 'void_requested')
  ) {
    const age = now.getTime() - row.updatedAt.getTime();
    if (age < STUCK_MS) {
      // Maybe still in flight: look again once it counts as stuck.
      await scheduleReconcile(deps, paymentId, Math.ceil((STUCK_MS - age) / 1000) + 5);
      return 'unchanged';
    }
    return resend(deps, paymentId, row.state, {
      proposalId: row.proposalId,
      authorizationId: row.authorizationId,
      payeeSlug: row.payeeSlug,
    });
  }

  const capture = row.captureId ? await deps.paypal.getCapture(row.captureId) : undefined;
  const target =
    lookup(CAPTURE_STATUS, capture?.status) ?? lookup(AUTHORIZATION_STATUS, auth.status);
  const payload = {
    authorizationStatus: auth.status,
    ...(capture ? { captureStatus: capture.status } : {}),
  };
  if (!target) {
    deps.log.warn({ paymentId, ...payload }, 'reconcile: unknown PayPal status');
    return 'unchanged';
  }

  const changed = await deps.db.transaction(async (tx) => {
    const [current] = await tx
      .select({ state: payments.state })
      .from(payments)
      .where(eq(payments.id, paymentId))
      .for('update');
    if (!current || !canTransition(current.state, target)) return false;
    // Only a human moves a hold towards capture; a PENDING authorization leaves it held.
    if (current.state === 'held' && target === 'capture_requested') return false;

    await tx
      .update(payments)
      .set({ state: target, updatedAt: sql`now()` })
      .where(eq(payments.id, paymentId));
    await tx.insert(paymentEvents).values({
      paymentId,
      source: 'reconciler',
      type: 'reconcile',
      fromState: current.state,
      toState: target,
      payload: { ...payload, settledBy: 'reconciler' },
    });
    await closeApproval(tx, paymentId, target, now);
    const owner = await paymentOwner(tx, paymentId);
    await notify(tx, {
      type: 'payment.updated',
      userId: owner?.userId,
      proposalId: owner?.proposalId,
      paymentId,
      state: target,
    });
    return true;
  });
  if (changed) deps.log.info({ paymentId, state: target, ...payload }, 'payment reconciled');
  return changed ? 'changed' : 'unchanged';
}

async function resend(
  deps: JobDeps,
  paymentId: string,
  state: 'capture_requested' | 'void_requested',
  p: { proposalId: string; authorizationId: string; payeeSlug: string },
): Promise<ReconcileResult> {
  const kind = state === 'capture_requested' ? 'capture' : 'void';
  const owner = await paymentOwner(deps.db, paymentId);
  const c: Claimed = {
    paymentId,
    proposalId: p.proposalId,
    userId: owner?.userId ?? '',
    authorizationId: p.authorizationId,
    payeeSlug: p.payeeSlug,
    // The original request ID; never a new one for the same payment.
    requestId: `tk-${p.proposalId}-${kind}`,
  };
  const { via, reason } = await requestedVia(deps, paymentId, kind);
  deps.log.warn({ paymentId, kind, requestId: c.requestId }, 'reconcile: resending stuck request');
  const after =
    kind === 'capture'
      ? await sendCapture(deps, c, via, 'reconciler')
      : await sendVoid(deps, c, via, reason, 'reconciler');
  deps.log.info({ paymentId, kind, state: after }, 'reconcile: resent');
  return 'resent';
}

/** One GET after a void, recorded as `reconcile.confirmed` (never changes state). */
async function confirmVoid(
  deps: JobDeps,
  paymentId: string,
  authorizationId: string | null,
): Promise<ReconcileResult> {
  if (!authorizationId) return 'skipped';
  const [done] = await deps.db
    .select({ id: paymentEvents.id })
    .from(paymentEvents)
    .where(
      and(eq(paymentEvents.paymentId, paymentId), eq(paymentEvents.type, 'reconcile.confirmed')),
    )
    .limit(1);
  if (done) return 'skipped';
  const auth = await deps.paypal.getAuthorization(authorizationId);
  await deps.db.insert(paymentEvents).values({
    paymentId,
    source: 'reconciler',
    type: 'reconcile.confirmed',
    fromState: 'voided',
    toState: 'voided',
    payload: { authorizationStatus: auth.status, matches: auth.status === 'VOIDED' },
  });
  if (auth.status !== 'VOIDED') {
    deps.log.error({ paymentId, authorizationStatus: auth.status }, 'void not confirmed by PayPal');
  }
  return 'confirmed';
}
