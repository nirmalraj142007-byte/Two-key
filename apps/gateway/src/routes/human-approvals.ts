import { AppError, ErrorCode, formatUSD } from '@twokey/core';
import { agentSessions, approvals, listings, merchants, payments, proposals } from '@twokey/db';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  createRequireHuman,
  type Human,
  type HumanAssertionVerifier,
} from '../auth/human-assertion.js';
import { OPEN_STATES } from '../jobs/sweep.js';
import { captureHeld, type SettleDeps, voidHeld } from '../services/settle.js';

export interface HumanApprovalRouteOptions extends Omit<SettleDeps, 'log'> {
  verifier: HumanAssertionVerifier;
}

const ListQuery = z.object({
  status: z.enum(['pending', 'approved', 'denied', 'timed_out']).default('pending'),
});
const IdParams = z.object({ id: z.uuid() });
const DecisionBody = z.object({
  decision: z.enum(['approve', 'deny']),
  via: z.enum(['web', 'phone']),
});

function humanOf(req: FastifyRequest): Human {
  if (!req.human) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Sign in again');
  return req.human;
}

/** The anomaly hit stored on the approval (see rules/evaluate.ts). */
const AnomalyDetail = z.object({
  expected: z.object({
    referenceCents: z.number().int().positive(),
    source: z.string().optional(),
  }),
  actual: z.object({ priceCents: z.number().int().positive() }),
});

function reference(reason: unknown, offers: number) {
  const parsed = AnomalyDetail.safeParse(reason);
  if (!parsed.success) {
    return { referencePriceCents: null, referencePrice: null, ratio: null, referenceOffers: null };
  }
  const ref = parsed.data.expected.referenceCents;
  const price = parsed.data.actual.priceCents;
  return {
    referencePriceCents: ref,
    referencePrice: formatUSD(ref),
    ratio: Math.round((price / ref) * 100) / 100,
    // Store count only when the reference is the same product's median across stores.
    referenceOffers: parsed.data.expected.source === 'product_median' ? offers : null,
  };
}

function approvalRows(db: HumanApprovalRouteOptions['db']) {
  return db
    .select({
      id: approvals.id,
      status: approvals.status,
      reason: approvals.reason,
      deadlineAt: approvals.deadlineAt,
      decidedAt: approvals.decidedAt,
      decidedVia: approvals.decidedVia,
      paymentId: payments.id,
      state: payments.state,
      amountCents: payments.amountCents,
      proposalId: proposals.id,
      qty: proposals.qty,
      product: listings.title,
      merchant: merchants.displayName,
      offers: listings.referenceNOffers,
    })
    .from(approvals)
    .innerJoin(payments, eq(payments.id, approvals.paymentId))
    .innerJoin(proposals, eq(proposals.id, payments.proposalId))
    .innerJoin(listings, eq(listings.id, proposals.listingId))
    .innerJoin(merchants, eq(merchants.id, payments.payeeMerchantId));
}

type ApprovalRow = Awaited<ReturnType<typeof approvalRows>>[number];

function toItem({ reason, amountCents, deadlineAt, decidedAt, offers, ...r }: ApprovalRow) {
  return {
    ...r,
    amountCents,
    amount: formatUSD(amountCents),
    ...reference(reason, offers),
    deadlineAt: deadlineAt.toISOString(),
    decidedAt: decidedAt?.toISOString() ?? null,
  };
}

export const humanApprovalRoutes: FastifyPluginAsync<HumanApprovalRouteOptions> = async (
  app,
  opts,
) => {
  const { db } = opts;
  const requireHuman = createRequireHuman(opts.verifier);
  app.decorateRequest('human', null);

  app.get('/human/approvals', { preHandler: requireHuman('approvals:decide') }, async (req) => {
    const { userId } = humanOf(req);
    const query = ListQuery.safeParse(req.query);
    if (!query.success) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'status must be pending, approved, denied or timed_out',
      );
    }
    const rows = await approvalRows(db)
      .where(and(eq(approvals.userId, userId), eq(approvals.status, query.data.status)))
      .orderBy(asc(approvals.deadlineAt))
      .limit(100);
    return { items: rows.map(toItem) };
  });

  app.get('/human/approvals/:id', { preHandler: requireHuman('approvals:decide') }, async (req) => {
    const { userId } = humanOf(req);
    const params = IdParams.safeParse(req.params);
    if (!params.success) throw new AppError(ErrorCode.NOT_FOUND, 'Hold not found');
    // Tenancy: another user's approval is the same 404 as a missing one.
    const [row] = await approvalRows(db)
      .where(and(eq(approvals.id, params.data.id), eq(approvals.userId, userId)))
      .limit(1);
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Hold not found');
    return toItem(row);
  });

  app.post(
    '/human/approvals/:id',
    { preHandler: requireHuman('approvals:decide') },
    async (req) => {
      const { userId } = humanOf(req);
      const params = IdParams.safeParse(req.params);
      if (!params.success) throw new AppError(ErrorCode.NOT_FOUND, 'Hold not found');
      const body = DecisionBody.safeParse(req.body);
      if (!body.success) {
        throw new AppError(
          ErrorCode.VALIDATION,
          "Body must be { decision: 'approve' | 'deny', via: 'web' | 'phone' }",
        );
      }
      // Tenancy: another user's approval is the same 404 as a missing one.
      const [approval] = await db
        .select({ paymentId: approvals.paymentId })
        .from(approvals)
        .where(and(eq(approvals.id, params.data.id), eq(approvals.userId, userId)))
        .limit(1);
      if (!approval) throw new AppError(ErrorCode.NOT_FOUND, 'Hold not found');

      const deps: SettleDeps = { ...opts, log: req.log };
      const { decision, via } = body.data;
      const { state } =
        decision === 'approve'
          ? await captureHeld(deps, approval.paymentId, via)
          : await voidHeld(deps, approval.paymentId, via, 'human_denied');
      req.log.info({ paymentId: approval.paymentId, decision, via, state }, 'hold decided');
      return { state };
    },
  );

  app.get('/human/stats', { preHandler: requireHuman('approvals:decide') }, async (req) => {
    const { userId } = humanOf(req);
    const [row] = await db
      .select({ n: count() })
      .from(payments)
      .innerJoin(proposals, eq(proposals.id, payments.proposalId))
      .innerJoin(agentSessions, eq(agentSessions.id, proposals.sessionId))
      .where(and(eq(agentSessions.userId, userId), inArray(payments.state, OPEN_STATES)));
    return { openAuthorizations: row?.n ?? 0 };
  });
};
