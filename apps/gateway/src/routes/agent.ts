import { AppError, ErrorCode, formatUSD, RuleCardSchema, toPayPalValue } from '@twokey/core';
import {
  agentSessions,
  catalogSnapshots,
  type Db,
  evalEpisodeListings,
  listings,
  merchants,
  payments,
  proposals,
  ruleCards,
} from '@twokey/db';
import { and, asc, desc, eq, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type AgentSession, requireAgent } from '../auth/agent-token.js';
import { searchWords } from '../services/catalog.js';
import type { Channel3Service } from '../services/channel3.js';
import { loadProposalResult, type PurchaseDeps, proposePurchase } from '../services/purchase.js';

export interface AgentRouteOptions extends Omit<PurchaseDeps, 'db' | 'log'> {
  db: Db;
  agentTokenPepper: string;
  channel3: Channel3Service;
}

/** Unknown keys (amount, payee, merchant, …) are stripped; only these two reach the gateway. */
const ProposalBody = z.object({
  product_id: z.string().min(1).max(100),
  qty: z.number().int().min(1).max(20),
});
const IdempotencyKey = z.string().min(1).max(200).optional();
const SearchQuery = z.object({
  q: z.string().min(1).max(200),
  max_price_cents: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(10).default(6),
});
const ProposalParams = z.object({ proposalId: z.uuid() });
const EVAL_RESULTS_MAX = 10;

function sessionOf(req: FastifyRequest): AgentSession {
  if (!req.agentSession) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Agent token required');
  return req.agentSession;
}

/** Makes %, _ and backslash literal inside an ILIKE pattern. */
function escapeLike(word: string): string {
  return word.replace(/[\\%_]/g, '\\$&');
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

  app.get('/agent/catalog/search', async (req) => {
    const session = sessionOf(req);
    const query = parse(SearchQuery, req.query, 'Query must be q (1-200 chars), limit (1-10)');
    const { q, limit } = query;
    const maxPriceCents = query.max_price_cents;

    type Item = {
      product_id: string;
      title: string;
      store: string;
      price_usd: string;
      category: string;
      untrusted_listing_text: string;
    };

    if (session.mode === 'live') {
      const live = await opts.channel3.search(db, q, {
        limit,
        ...(maxPriceCents === undefined ? {} : { maxPriceCents }),
      });
      return {
        items: live.items.map(
          (i): Item => ({
            product_id: i.listingId,
            title: i.title,
            store: i.store,
            price_usd: toPayPalValue(i.priceCents),
            category: i.category,
            untrusted_listing_text: i.description,
          }),
        ),
        unmapped_offers: live.unmappedOffers,
      };
    }

    // Evaluation: the episode's own listings in position order, whatever the query, price filter
    // or limit. Determinism beats realism here: every model sees exactly the same results for an
    // episode, so differences between runs come from the model, not from its search wording.
    if (session.mode === 'eval') {
      if (!session.evalEpisodeId) return { items: [] };
      const rows = await db
        .select({
          id: listings.id,
          title: listings.title,
          store: merchants.displayName,
          priceCents: listings.priceCents,
          category: listings.category,
          description: listings.description,
        })
        .from(evalEpisodeListings)
        .innerJoin(listings, eq(listings.id, evalEpisodeListings.listingId))
        .innerJoin(merchants, eq(merchants.id, listings.merchantId))
        .where(eq(evalEpisodeListings.episodeId, session.evalEpisodeId))
        .orderBy(asc(evalEpisodeListings.position))
        .limit(EVAL_RESULTS_MAX);
      return {
        items: rows.map(
          (r): Item => ({
            product_id: r.id,
            title: r.title,
            store: r.store,
            price_usd: toPayPalValue(r.priceCents),
            category: r.category,
            untrusted_listing_text: r.description,
          }),
        ),
      };
    }

    // Demo and hijack: a listing matches when ANY query word is in its title or category, ranked
    // by how many words match, then price. Hijack listings that belong to one session arrive with
    // phase 22.
    const words = searchWords(q).map((w) => `%${escapeLike(w)}%`);
    if (words.length === 0) return { items: [] };
    const hit = (w: string) => or(ilike(listings.title, w), ilike(listings.category, w));
    const matches = sql<number>`(${sql.join(
      words.map((w) => sql`(case when ${hit(w)} then 1 else 0 end)`),
      sql` + `,
    )})`;
    const rows = await db
      .select({
        id: listings.id,
        title: listings.title,
        store: merchants.displayName,
        priceCents: listings.priceCents,
        category: listings.category,
        description: listings.description,
      })
      .from(listings)
      .innerJoin(catalogSnapshots, eq(catalogSnapshots.id, listings.snapshotId))
      .innerJoin(merchants, eq(merchants.id, listings.merchantId))
      .where(
        and(
          eq(catalogSnapshots.kind, 'demo_unbranded'),
          maxPriceCents === undefined ? undefined : lte(listings.priceCents, maxPriceCents),
          or(...words.map(hit)),
        ),
      )
      .orderBy(desc(matches), asc(listings.priceCents), asc(listings.title))
      .limit(limit);
    return {
      items: rows.map(
        (r): Item => ({
          product_id: r.id,
          title: r.title,
          store: r.store,
          price_usd: toPayPalValue(r.priceCents),
          category: r.category,
          untrusted_listing_text: r.description,
        }),
      ),
    };
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
