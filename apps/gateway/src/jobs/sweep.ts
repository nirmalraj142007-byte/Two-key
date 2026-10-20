import type { PaymentState } from '@twokey/core';
import { payments } from '@twokey/db';
import { and, count, eq, inArray, lt, lte } from 'drizzle-orm';
import { handleHoldTimeout } from './hold-timeout.js';
import type { JobDeps } from './queue.js';
import { reconcilePayment } from './reconcile.js';

/** Payments that hold (or may hold) an open PayPal authorization. */
export const OPEN_STATES: PaymentState[] = [
  'authorizing',
  'authorized',
  'held',
  'capture_requested',
  'void_requested',
];
const IN_FLIGHT: PaymentState[] = [
  'authorizing',
  'authorized',
  'capture_requested',
  'void_requested',
];
const STALE_MS = 10 * 60 * 1000;

/**
 * sweep.open-auths (daily, and once on boot): voids every hold past its deadline (the timer is
 * the primary path; this catches lost timers), reconciles every in-flight payment untouched for
 * 10 minutes, and logs how many authorizations are still open. One bad payment never stops it.
 */
export async function runSweep(
  deps: JobDeps,
): Promise<{ voided: number; reconciled: number; openAuthorizations: number }> {
  const now = deps.now?.() ?? new Date();
  const overdue = await deps.db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.state, 'held'), lte(payments.holdDeadlineAt, now)));
  let voided = 0;
  for (const { id } of overdue) {
    try {
      if (await handleHoldTimeout(deps, { paymentId: id })) voided += 1;
    } catch (err) {
      deps.log.error({ paymentId: id, err }, 'sweep: void failed');
    }
  }

  const stale = await deps.db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        inArray(payments.state, IN_FLIGHT),
        lt(payments.updatedAt, new Date(now.getTime() - STALE_MS)),
      ),
    );
  let reconciled = 0;
  for (const { id } of stale) {
    try {
      if ((await reconcilePayment(deps, id)) === 'changed') reconciled += 1;
    } catch (err) {
      deps.log.error({ paymentId: id, err }, 'sweep: reconcile failed');
    }
  }

  const [open] = await deps.db
    .select({ n: count() })
    .from(payments)
    .where(inArray(payments.state, OPEN_STATES));
  const openAuthorizations = open?.n ?? 0;
  deps.log.info({ voided, reconciled, openAuthorizations }, 'sweep finished');
  return { voided, reconciled, openAuthorizations };
}
