import { canTransition, type PaymentState, TERMINAL } from '@twokey/core';
import { paymentEvents, payments } from '@twokey/db';
import { eq, sql } from 'drizzle-orm';
import { closeApproval, notify, paymentOwner } from '../services/settle.js';
import type { JobDeps } from './queue.js';

export type ReconcileDeps = Pick<JobDeps, 'db' | 'log' | 'now'> & {
  paypal: Pick<JobDeps['paypal'], 'getAuthorization' | 'getCapture'>;
};
export type ReconcileResult = 'changed' | 'unchanged' | 'skipped';

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

function lookup(table: Readonly<Record<string, PaymentState>>, status: string | undefined) {
  return status && Object.hasOwn(table, status) ? table[status] : undefined;
}

/**
 * payment.reconcile: reads the authorization (and the capture, when there is one) from PayPal
 * and moves the payment forward to match. Records an event only when the state changes. This
 * is what settles a payment whose webhook never arrived.
 */
export async function reconcilePayment(
  deps: ReconcileDeps,
  paymentId: string,
): Promise<ReconcileResult> {
  const [row] = await deps.db
    .select({
      state: payments.state,
      authorizationId: payments.paypalAuthorizationId,
      captureId: payments.paypalCaptureId,
    })
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);
  if (!row || TERMINAL.has(row.state)) return 'skipped';
  if (!row.authorizationId) {
    deps.log.warn({ paymentId, state: row.state }, 'reconcile: payment has no authorization ID');
    return 'skipped';
  }

  const auth = await deps.paypal.getAuthorization(row.authorizationId);
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

  const now = deps.now?.() ?? new Date();
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
      payload,
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
