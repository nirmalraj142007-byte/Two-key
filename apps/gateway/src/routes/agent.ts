import { AppError, ErrorCode, formatUSD, RuleCardSchema } from '@twokey/core';
import { agentSessions, type Db, merchants, payments, proposals, ruleCards } from '@twokey/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type AgentSession, requireAgent } from '../auth/agent-token.js';
import { loadProposalResult, type PurchaseDeps, proposePurchase } from '../services/purchase.js';

export interface AgentRouteOptions extends Omit<PurchaseDeps, 'db' | 'log'> {
  db: Db;
  agentTokenPepper: string;
}

/** Unknown keys (amount, payee, merchant, …) are stripped; only these two reach the gateway. */
const ProposalBody = z.object({
  product_id: z.string().min(1).max(100),
  qty: z.number().int().min(1).max(20),
});
const IdempotencyKey = z.string().min(1).max(200).optional();
const ProposalParams = z.object({ proposalId: z.uuid() });

function sessionOf(req: FastifyRequest): AgentSession {
  if (!req.agentSession) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Agent token required');
  return req.agentSession;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(ErrorCode.VALIDATION, message);
  return result.data;
}

export const agentRoutes: FastifyPluginAsync<AgentRouteOptions> = async (app, opts) => {
  const { db } = opts;
  app.decorateRequest('agentSession', null);
  app.addHook('preHandler', requireAgent(db, opts.agentTokenPepper));

  app.post('/agent/proposals', async (req) => {
    const session = sessionOf(req);
    const body = parse(ProposalBody, req.body, 'Body must be { product_id, qty (1–20) }');
    const idempotencyKey = parse(
      IdempotencyKey,
      req.headers['idempotency-key'],
      'Idempotency-Key must be 1–200 characters',
    );
    try {
      return await proposePurchase(
        { ...opts, db, log: req.log },
        { session, productId: body.product_id, qty: body.qty, idempotencyKey, rawArgs: req.body },
      );
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Fail closed: if a decision can't be persisted, nothing is bought.
      req.log.error({ err, sessionId: session.id }, 'proposal failed');
      throw new AppError(ErrorCode.INTERNAL, 'Not purchased — retry', { retryable: true });
    }
  });

  app.get('/agent/purchases/:proposalId', async (req) => {
    const session = sessionOf(req);
    const notFound = new AppError(ErrorCode.NOT_FOUND, 'Unknown proposal');
    const params = ProposalParams.safeParse(req.params);
    if (!params.success) throw notFound;
    const { proposalId } = params.data;

    // Tenancy: only proposals made by one of this user's sessions; anyone else's is a 404.
    const [own] = await db
      .select({ orderId: payments.paypalOrderId })
      .from(proposals)
      .innerJoin(agentSessions, eq(agentSessions.id, proposals.sessionId))
      .leftJoin(payments, eq(payments.proposalId, proposals.id))
      .where(and(eq(proposals.id, proposalId), eq(agentSessions.userId, session.userId)))
      .limit(1);
    if (!own) throw notFound;

    try {
      const result = await loadProposalResult(db, proposalId);
      return {
        decision: result.decision,
        paymentState: result.paymentState ?? null,
        ...(own.orderId ? { paypalOrderId: own.orderId } : {}),
      };
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.CONFLICT) {
        return { decision: 'pending', paymentState: 'authorizing' };
      }
      throw err;
    }
  });

  app.get('/agent/rules', async (req) => {
    const session = sessionOf(req);
    const [row] = await db
      .select({ status: ruleCards.status, rules: ruleCards.rules })
      .from(ruleCards)
      .where(and(eq(ruleCards.id, session.ruleCardId), eq(ruleCards.userId, session.userId)))
      .limit(1);
    const parsed = row ? RuleCardSchema.safeParse(row.rules) : undefined;
    if (!row || !parsed?.success) throw new AppError(ErrorCode.NOT_FOUND, 'No active rules');
    const card = parsed.data;

    const stores = await db
      .select({ name: merchants.displayName })
      .from(merchants)
      .where(inArray(merchants.id, card.allowedMerchantIds));

    // Plain form only: no signature, key ID or internal IDs.
    return {
      status: row.status,
      currency: card.currency,
      perItemCap: formatUSD(card.perItemCapCents),
      perOrderCap: formatUSD(card.perOrderCapCents),
      perItemCapCents: card.perItemCapCents,
      perOrderCapCents: card.perOrderCapCents,
      stores: stores.map((s) => s.name).sort(),
      ...(card.allowedCategories ? { categories: card.allowedCategories } : {}),
      maxQtyPerOrder: card.maxQtyPerOrder,
      frequency: card.frequency,
      expiresAt: card.expiresAt,
      advisory: card.advisory.map((a) => ({
        label: a.label,
        value: a.value,
        note: "Agent's job — not checked by Two-Key",
      })),
    };
  });
};
