import { AppError, canTransition, ErrorCode, type PaymentState, TERMINAL } from '@twokey/core';
import { agentSessions, approvals, type Db, paymentEvents, payments, proposals } from '@twokey/db';
import { and, eq, sql } from 'drizzle-orm';
import { type JobDeps, scheduleReconcile } from '../jobs/queue.js';
import { NOTIFY_CHANNEL } from './webhook-apply.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type SettleDeps = Pick<JobDeps, 'db' | 'jobs' | 'log' | 'now'> & {
  paypal: Pick<JobDeps['paypal'], 'capture' | 'voidAuthorization'>;
};
export type Via = 'web' | 'phone' | 'timer';
type ApprovalStatus = 'approved' | 'denied' | 'timed_out';

export const HOLD_VOIDED = 'This hold was voided. No charge was made.';
export const ALREADY_DECIDED = 'Already decided';

export async function notify(tx: Tx, notice: Record<string, unknown>): Promise<void> {
  await tx.execute(sql`select pg_notify(${NOTIFY_CHANNEL}, ${JSON.stringify(notice)})`);
}

function errorPayload(err: unknown): Record<string, unknown> {
  if (err instanceof AppError) {
    return {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      details: err.details ?? {},
    };
  }
  return { code: ErrorCode.INTERNAL, message: 'Internal error', retryable: false, details: {} };
}

/** PayPal's 422 for a capture or void on an authorization past its 29 days. Never retried. */
export function isAuthorizationExpired(err: unknown): boolean {
  if (!(err instanceof AppError) || err.code !== ErrorCode.UPSTREAM_PAYPAL) return false;
  const d = err.details as { httpStatus?: unknown; issues?: unknown } | undefined;
  return (
    d?.httpStatus === 422 && Array.isArray(d.issues) && d.issues.includes('AUTHORIZATION_EXPIRED')
  );
}

interface Claimed {
  paymentId: string;
  proposalId: string;
  userId: string;
  authorizationId: string;
  requestId: string;
}

/**
 * Locks the payment and its approval, checks the hold can still be decided, and moves it to
 * `to` before any PayPal call. The lock plus the state check is what makes a second capture or
 * void for the same payment impossible: the loser sees a non-held state and gets 409.
 */
async function claim(
  deps: SettleDeps,
  paymentId: string,
  to: 'capture_requested' | 'void_requested',
  via: Via,
  payload: Record<string, unknown>,
): Promise<Claimed> {
  const now = deps.now?.() ?? new Date();
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        state: payments.state,
        authorizationId: payments.paypalAuthorizationId,
        proposalId: payments.proposalId,
        userId: approvals.userId,
        approval: approvals.status,
        deadlineAt: approvals.deadlineAt,
      })
      .from(payments)
      .innerJoin(approvals, eq(approvals.paymentId, payments.id))
      .where(eq(payments.id, paymentId))
      .for('update', { of: [payments, approvals] });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Hold not found');

    const pastDeadline = now.getTime() >= row.deadlineAt.getTime();
    if (row.approval === 'timed_out' || (via !== 'timer' && pastDeadline)) {
      throw new AppError(ErrorCode.CONFLICT, HOLD_VOIDED);
    }
    if (row.state !== 'held' || row.approval !== 'pending' || !canTransition(row.state, to)) {
      throw new AppError(ErrorCode.CONFLICT, ALREADY_DECIDED);
    }
    if (!row.authorizationId) {
      throw new AppError(ErrorCode.INTERNAL, 'Held payment has no authorization');
    }

    const kind = to === 'capture_requested' ? 'capture' : 'void';
    const requestId = `tk-${row.proposalId}-${kind}`;
    await tx
      .update(payments)
      .set({ state: to, updatedAt: sql`now()` })
      .where(eq(payments.id, paymentId));
    await tx.insert(paymentEvents).values({
      paymentId,
      source: via === 'timer' ? 'timer' : 'human',
      type: `${kind}.requested`,
      fromState: 'held',
      toState: to,
      requestId,
      payload: { via, ...payload },
    });
    await notify(tx, {
      type: 'payment.updated',
      userId: row.userId,
      proposalId: row.proposalId,
      paymentId,
      state: to,
    });
    return {
      paymentId,
      proposalId: row.proposalId,
      userId: row.userId,
      authorizationId: row.authorizationId,
      requestId,
    };
  });
}

interface Finish {
  from: PaymentState;
  /** Omitted: the state stays where it is and only an event is recorded. */
  to?: PaymentState;
  type: string;
  payload: Record<string, unknown>;
  set?: Partial<typeof payments.$inferInsert>;
  approval: ApprovalStatus;
  via: Via;
}

/**
 * Applies PayPal's answer. A webhook may have moved the payment already; then only the event
 * and the approval are written. Returns the payment's state afterwards.
 */
async function finish(deps: SettleDeps, c: Claimed, f: Finish): Promise<PaymentState> {
  const now = deps.now?.() ?? new Date();
  return deps.db.transaction(async (tx) => {
    const [current] = await tx
      .select({ state: payments.state })
      .from(payments)
      .where(eq(payments.id, c.paymentId))
      .for('update');
    if (!current) throw new AppError(ErrorCode.INTERNAL, 'Payment disappeared');
    const moves = f.to !== undefined && current.state === f.from && canTransition(f.from, f.to);
    const state = moves ? (f.to as PaymentState) : current.state;

    if (moves || f.set) {
      await tx
        .update(payments)
        .set({ ...f.set, ...(moves ? { state } : {}), updatedAt: sql`now()` })
        .where(eq(payments.id, c.paymentId));
    }
    await tx.insert(paymentEvents).values({
      paymentId: c.paymentId,
      source: 'api_response',
      type: f.type,
      fromState: current.state,
      toState: state,
      requestId: c.requestId,
      payload: f.payload,
    });
    await tx
      .update(approvals)
      .set({
        status: f.approval,
        decidedAt: now,
        decidedVia: f.via === 'timer' ? null : f.via,
      })
      .where(and(eq(approvals.paymentId, c.paymentId), eq(approvals.status, 'pending')));
    if (moves) {
      await notify(tx, {
        type: 'payment.updated',
        userId: c.userId,
        proposalId: c.proposalId,
        paymentId: c.paymentId,
        state,
      });
    }
    return state;
  });
}

/** The human approved a held payment: capture it. */
export async function captureHeld(
  deps: SettleDeps,
  paymentId: string,
  via: Exclude<Via, 'timer'>,
): Promise<{ state: PaymentState }> {
  const c = await claim(deps, paymentId, 'capture_requested', via, {});
  const from = 'capture_requested';
  let state: PaymentState;
  try {
    const res = await deps.paypal.capture({
      authorizationId: c.authorizationId,
      requestId: c.requestId,
    });
    const payload = { captureId: res.captureId, status: res.status };
    const set = { paypalCaptureId: res.captureId || null };
    state = await finish(deps, c, {
      from,
      // PENDING (or anything else) stays in capture_requested: the webhook or reconciler ends it.
      ...(res.status === 'COMPLETED' ? { to: 'captured' as const } : {}),
      type: res.status === 'COMPLETED' ? 'capture.completed' : 'capture.pending',
      payload,
      set,
      approval: 'approved',
      via,
    });
  } catch (err) {
    deps.log.warn({ paymentId, err: errorPayload(err) }, 'held capture failed');
    if (isAuthorizationExpired(err)) {
      state = await finish(deps, c, {
        from,
        to: 'expired',
        type: 'capture.authorization_expired',
        payload: { issue: 'AUTHORIZATION_EXPIRED', ...errorPayload(err) },
        approval: 'timed_out',
        via,
      });
    } else {
      const retryable = err instanceof AppError && err.retryable;
      // Retryable (5xx, timeout): PayPal may have captured; stay and let the reconciler read it.
      state = await finish(deps, c, {
        from,
        ...(retryable ? {} : { to: 'failed' as const }),
        type: 'paypal.error',
        payload: errorPayload(err),
        approval: 'approved',
        via,
      });
    }
  }
  await scheduleReconcile(deps, paymentId);
  return { state };
}

/** The human denied a held payment, or its timer ran out: void the authorization. */
export async function voidHeld(
  deps: SettleDeps,
  paymentId: string,
  via: Via,
  reason: string,
): Promise<{ state: PaymentState }> {
  const c = await claim(deps, paymentId, 'void_requested', via, { reason });
  const from = 'void_requested';
  const approval: ApprovalStatus = via === 'timer' ? 'timed_out' : 'denied';
  let state: PaymentState;
  try {
    const res = await deps.paypal.voidAuthorization({
      authorizationId: c.authorizationId,
      requestId: c.requestId,
    });
    state = await finish(deps, c, {
      from,
      to: 'voided',
      type: 'void.completed',
      payload: { status: res.status, reason },
      approval,
      via,
    });
  } catch (err) {
    deps.log.warn({ paymentId, err: errorPayload(err) }, 'held void failed');
    const expired = isAuthorizationExpired(err);
    // Anything else stays in void_requested; the reconciler settles it from GET authorization.
    state = await finish(deps, c, {
      from,
      ...(expired ? { to: 'expired' as const } : {}),
      type: expired ? 'void.authorization_expired' : 'paypal.error',
      payload: { ...(expired ? { issue: 'AUTHORIZATION_EXPIRED' } : {}), ...errorPayload(err) },
      approval,
      via,
    });
  }
  await scheduleReconcile(deps, paymentId);
  return { state };
}

/** Closes a still-pending approval once its payment reached a terminal state some other way. */
export async function closeApproval(
  tx: Tx,
  paymentId: string,
  state: PaymentState,
  now: Date,
): Promise<void> {
  if (!TERMINAL.has(state)) return;
  const [row] = await tx
    .select({ deadlineAt: approvals.deadlineAt })
    .from(approvals)
    .where(and(eq(approvals.paymentId, paymentId), eq(approvals.status, 'pending')))
    .for('update');
  if (!row) return;
  const status: ApprovalStatus =
    state === 'captured'
      ? 'approved'
      : state === 'expired' || now.getTime() >= row.deadlineAt.getTime()
        ? 'timed_out'
        : 'denied';
  await tx
    .update(approvals)
    .set({ status, decidedAt: now })
    .where(and(eq(approvals.paymentId, paymentId), eq(approvals.status, 'pending')));
}

/** The owning user of a payment, for notices. */
export async function paymentOwner(db: Db | Tx, paymentId: string) {
  const [row] = await db
    .select({ userId: agentSessions.userId, proposalId: proposals.id })
    .from(payments)
    .innerJoin(proposals, eq(proposals.id, payments.proposalId))
    .innerJoin(agentSessions, eq(agentSessions.id, proposals.sessionId))
    .where(eq(payments.id, paymentId))
    .limit(1);
  return row;
}
