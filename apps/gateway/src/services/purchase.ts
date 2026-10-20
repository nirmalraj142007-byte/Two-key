import {
  AppError,
  canTransition,
  decideGate,
  ErrorCode,
  formatUSD,
  GATE_VERSION,
  type PaymentState,
  type RuleCard,
  type RuleHit,
  type RuleId,
  verifyCard,
} from '@twokey/core';
import {
  agentSessions,
  approvals,
  type Db,
  gateDecisions,
  listings,
  merchants,
  paymentEvents,
  payments,
  proposals,
  ruleCards,
  vaultTokens,
} from '@twokey/db';
import type { OrdersApi } from '@twokey/paypal';
import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { AgentSession } from '../auth/agent-token.js';
import { type Jobs, scheduleHoldTimeout } from '../jobs/queue.js';
import { resolveListing } from './catalog.js';
import type { RuleKeys } from './keys.js';
import { NOTIFY_CHANNEL } from './webhook-apply.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Logger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

export type Decision = 'captured' | 'held' | 'blocked' | 'failed' | 'recorded';
export type BlockedBy = RuleId | 'rule_card_invalid';

export interface ProposalResult {
  proposalId: string;
  decision: Decision;
  reason: string;
  blockedBy?: BlockedBy;
  paypalOrderCreated: boolean;
  paymentState?: PaymentState;
  retryable?: boolean;
}

export interface PurchaseDeps {
  db: Db;
  paypal: Pick<OrdersApi, 'createVaultedAuthorization' | 'capture'>;
  keys: RuleKeys;
  log: Logger;
  /** hold.timeout is sent here when a purchase is held. */
  jobs: Jobs;
  now?: () => Date;
  /** Overrides the card's holdTimeoutMinutes for demo and hijack sessions. */
  demoHoldMinutes?: number | undefined;
}

export interface ProposeInput {
  session: AgentSession;
  productId: string;
  qty: number;
  idempotencyKey?: string | undefined;
  rawArgs: unknown;
}

const HONOR_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;
const AUTHORIZATION_MS = 29 * 24 * 60 * 60 * 1000;
const PAYPAL_ITEM_NAME_MAX = 127;
const AGENT_FIELDS = new Set(['product_id', 'qty']);

/** Payments that count against the frequency rule. `authorizing` is included so two
 * concurrent proposals cannot both slip under the limit while the first is in flight. */
const COUNTED_STATES: PaymentState[] = [
  'authorizing',
  'authorized',
  'held',
  'capture_requested',
  'captured',
];

export const NO_ORDER = 'No PayPal order created.';
export const CONNECT_PAYPAL = 'Connect PayPal first';
export const PAYPAL_DECLINED = 'PayPal declined — no money moved';

type StoredHit = Omit<RuleHit, 'rule'> & { rule: RuleHit['rule'] | 'rule_card_invalid' };

// ---------------------------------------------------------------------------------------------
// Reasons. Built only from stored rows, so a replayed idempotent request reads the same.

function cents(v: unknown): string {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? formatUSD(v) : '?';
}

function blockSentence(hit: StoredHit, merchantName: string, category: string): string {
  const { expected, actual } = hit.detail;
  switch (hit.rule) {
    case 'expiry':
      return 'Your spending rules have expired.';
    case 'rule_card_invalid':
      return "Your spending rules couldn't be verified.";
    case 'merchant_allowlist':
      return `${merchantName} isn't in your stores.`;
    case 'per_item_cap':
      return `${cents(actual)} is over your ${cents(expected)} per-item limit.`;
    case 'per_order_cap':
      return `This order's ${cents(actual)} total is over your ${cents(expected)} per-order limit.`;
    case 'max_qty':
      return `Quantity ${String(actual)} is over your limit of ${String(expected)} per order.`;
    case 'category':
      return `${category.replaceAll('_', ' ')} isn't one of your allowed categories.`;
    case 'frequency': {
      const e = expected as { maxPurchases?: number; windowHours?: number };
      return `You've reached your limit of ${e.maxPurchases} purchases in ${e.windowHours} hours.`;
    }
    default:
      return 'This purchase breaks one of your rules.';
  }
}

function holdSentence(hit: StoredHit | undefined, referenceOffers: number): string {
  const expected = hit?.detail.expected as { referenceCents?: number; source?: string } | undefined;
  const actual = hit?.detail.actual as { priceCents?: number } | undefined;
  const ref = expected?.referenceCents;
  const price = actual?.priceCents;
  if (!ref || !price) return 'Held for your approval: the price looks unusual.';
  const pct = Math.round((price / ref - 1) * 100);
  const where =
    expected?.source === 'product_median'
      ? `at ${referenceOffers} stores`
      : 'for similar items in this category';
  return `Held for your approval: ${formatUSD(price)} is ${pct}% above the usual price ${where}.`;
}

// ---------------------------------------------------------------------------------------------
// Result rebuild

async function proposalIdForKey(db: Db, sessionId: string, key: string) {
  const [row] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(and(eq(proposals.sessionId, sessionId), eq(proposals.idempotencyKey, key)))
    .limit(1);
  return row?.id;
}

/** Rebuilds a proposal's result from its rows. Every response, first or replayed, comes from here. */
export async function loadProposalResult(db: Db, proposalId: string): Promise<ProposalResult> {
  const [row] = await db
    .select({
      mode: agentSessions.mode,
      qty: proposals.qty,
      amountCents: proposals.resolvedAmountCents,
      title: listings.title,
      category: listings.category,
      referenceOffers: listings.referenceNOffers,
      merchantName: merchants.displayName,
      payeeId: merchants.paypalMerchantId,
      outcome: gateDecisions.outcome,
      hits: gateDecisions.ruleHits,
      paymentId: payments.id,
      state: payments.state,
      orderId: payments.paypalOrderId,
    })
    .from(proposals)
    .innerJoin(agentSessions, eq(agentSessions.id, proposals.sessionId))
    .innerJoin(listings, eq(listings.id, proposals.listingId))
    .innerJoin(merchants, eq(merchants.id, proposals.resolvedMerchantId))
    .innerJoin(
      gateDecisions,
      and(eq(gateDecisions.proposalId, proposals.id), eq(gateDecisions.gate, 'G4')),
    )
    .leftJoin(payments, eq(payments.proposalId, proposals.id))
    .where(eq(proposals.id, proposalId))
    .limit(1);
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Unknown proposal');

  const hits = (row.hits ?? []) as StoredHit[];
  const base = { proposalId, paypalOrderCreated: row.orderId != null };

  if (row.outcome === 'block') {
    const hit = hits.find((h) => !h.passed);
    return {
      ...base,
      decision: 'blocked',
      reason: `${hit ? blockSentence(hit, row.merchantName, row.category) : 'Blocked by your rules.'} ${NO_ORDER}`,
      ...(hit ? { blockedBy: hit.rule as BlockedBy } : {}),
    };
  }
  if (row.mode === 'eval') {
    return {
      ...base,
      decision: 'recorded',
      reason: 'Recorded for evaluation. No PayPal call made.',
    };
  }
  if (!row.paymentId || !row.state) {
    if (!row.payeeId) throw missingPayee();
    return { ...base, decision: 'failed', reason: CONNECT_PAYPAL, retryable: false };
  }

  const paymentState = row.state;
  if (paymentState === 'failed') {
    const [err] = await db
      .select({ payload: paymentEvents.payload })
      .from(paymentEvents)
      .where(
        and(eq(paymentEvents.paymentId, row.paymentId), eq(paymentEvents.type, 'paypal.error')),
      )
      .orderBy(desc(paymentEvents.receivedAt))
      .limit(1);
    const retryable = (err?.payload as { retryable?: unknown } | undefined)?.retryable === true;
    return { ...base, decision: 'failed', reason: PAYPAL_DECLINED, paymentState, retryable };
  }
  if (paymentState === 'authorizing' || paymentState === 'authorized') {
    throw new AppError(ErrorCode.CONFLICT, 'This purchase is still being processed', {
      retryable: true,
    });
  }
  if (row.outcome === 'hold') {
    const hit = hits.find((h) => h.rule === 'anomaly');
    return {
      ...base,
      decision: 'held',
      reason: holdSentence(hit, row.referenceOffers),
      paymentState,
    };
  }
  const amount = formatUSD(row.amountCents);
  const reason =
    paymentState === 'capture_requested'
      ? `Paid ${row.merchantName} ${amount} for ${row.title}; PayPal is still processing it.`
      : `Bought ${row.title} from ${row.merchantName} for ${amount}.`;
  return { ...base, decision: 'captured', reason, paymentState };
}

// ---------------------------------------------------------------------------------------------
// Guards and state changes

function missingPayee(): AppError {
  return new AppError(ErrorCode.INTERNAL, 'Merchant has no PayPal merchant ID');
}

/** Evaluation sessions stop after the gate decision. Reaching PayPal from one is a bug. */
function assertNotEval(session: Pick<AgentSession, 'mode'>): void {
  if (session.mode === 'eval') {
    throw new AppError(ErrorCode.INTERNAL, 'Evaluation sessions never call PayPal');
  }
}

async function notify(tx: Tx, notice: Record<string, unknown>): Promise<void> {
  await tx.execute(sql`select pg_notify(${NOTIFY_CHANNEL}, ${JSON.stringify(notice)})`);
}

interface MoveOptions {
  userId: string;
  proposalId: string;
  from: PaymentState;
  to: PaymentState;
  type: string;
  requestId?: string;
  payload?: Record<string, unknown>;
  set?: Partial<typeof payments.$inferInsert>;
  /** Runs inside the same transaction, after the state change. */
  after?: (tx: Tx) => Promise<void>;
}

/** Locks the payment row, checks it is still in `from` and that `to` is a forward move, then applies. */
async function movePayment(db: Db, paymentId: string, o: MoveOptions): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ state: payments.state })
      .from(payments)
      .where(eq(payments.id, paymentId))
      .for('update');
    if (!current || current.state !== o.from || !canTransition(current.state, o.to)) {
      throw new AppError(
        ErrorCode.STATE_TRANSITION_INVALID,
        `Payment cannot move from ${current?.state ?? 'missing'} to ${o.to}`,
        { details: { expected: o.from, actual: current?.state ?? null, to: o.to } },
      );
    }
    await tx
      .update(payments)
      .set({ ...o.set, state: o.to, updatedAt: sql`now()` })
      .where(eq(payments.id, paymentId));
    await tx.insert(paymentEvents).values({
      paymentId,
      source: 'api_response',
      type: o.type,
      fromState: o.from,
      toState: o.to,
      requestId: o.requestId ?? null,
      payload: o.payload ?? {},
    });
    await o.after?.(tx);
    await notify(tx, {
      type: 'payment.updated',
      userId: o.userId,
      proposalId: o.proposalId,
      paymentId,
      state: o.to,
    });
  });
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

// ---------------------------------------------------------------------------------------------
// Rule card

type CardCheck = { ok: true; card: RuleCard } | { ok: false; hit: StoredHit };

async function loadCard(deps: PurchaseDeps, session: AgentSession, now: Date): Promise<CardCheck> {
  const [row] = await deps.db
    .select()
    .from(ruleCards)
    .where(and(eq(ruleCards.id, session.ruleCardId), eq(ruleCards.userId, session.userId)))
    .limit(1);
  const invalid = (actual: unknown): CardCheck => ({
    ok: false,
    hit: { rule: 'rule_card_invalid', passed: false, detail: { expected: 'signed', actual } },
  });
  const expired = (): CardCheck => ({
    ok: false,
    hit: {
      rule: 'expiry',
      passed: false,
      detail: { expected: row?.expiresAt?.toISOString() ?? null, actual: now.toISOString() },
    },
  });

  if (!row) return invalid('missing');
  if (row.status === 'expired') return expired();
  if (row.status !== 'signed' || !row.hmac || !row.keyId) return invalid(row.status);
  try {
    const card = verifyCard(
      { card: row.rules, keyId: row.keyId, alg: 'HS256', sig: row.hmac },
      deps.keys,
      now,
    );
    if (card.userId !== session.userId) return invalid('wrong_user');
    return { ok: true, card };
  } catch (err) {
    const reason = err instanceof AppError ? err.details?.reason : undefined;
    return reason === 'expired' ? expired() : invalid(reason ?? 'unverifiable');
  }
}

function isIdempotencyConflict(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    const pg = e as { code?: unknown; constraint_name?: unknown };
    if (pg.code === '23505' && pg.constraint_name === 'proposals_session_idempotency') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------

/**
 * The agent's only money action. Price and payee come from our rows; hard rules run before any
 * PayPal call; only a passing proposal creates a vaulted AUTHORIZE order, which is then
 * captured (clean) or held (anomalous). No LLM is involved anywhere on this path.
 */
export async function proposePurchase(
  deps: PurchaseDeps,
  i: ProposeInput,
): Promise<ProposalResult> {
  const { db, log } = deps;
  const { session } = i;
  const now = deps.now?.() ?? new Date();

  // a. Idempotent replay.
  if (i.idempotencyKey) {
    const existing = await proposalIdForKey(db, session.id, i.idempotencyKey);
    if (existing) return loadProposalResult(db, existing);
  }

  // c. Resolve listing and payee ourselves; anything else the agent sent is ignored.
  const ignoredFields =
    i.rawArgs !== null && typeof i.rawArgs === 'object'
      ? Object.keys(i.rawArgs).filter((k) => !AGENT_FIELDS.has(k))
      : [];
  if (ignoredFields.length > 0) {
    log.info({ sessionId: session.id, ignoredFields }, 'ignored agent-supplied fields');
  }
  const { listing, merchant, gateListing } = await resolveListing(db, i.productId, session);
  const amountCents = listing.priceCents * i.qty;

  // b. Signed rule card.
  const cardCheck = await loadCard(deps, session, now);

  // d. Decide and record under a per-user lock, so the frequency count is serialized.
  let recorded: {
    proposalId: string;
    outcome: 'capture' | 'hold' | 'block' | 'ask_every_time';
    card?: RuleCard;
    anomaly?: RuleHit;
    payment?: { id: string; vaultId: string; payeeId: string };
    noPayee?: boolean;
  };
  try {
    recorded = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${session.userId}))`);

      let outcome: 'capture' | 'hold' | 'block' | 'ask_every_time';
      let hits: StoredHit[];
      if (cardCheck.ok) {
        const since = new Date(now.getTime() - cardCheck.card.frequency.windowHours * 3_600_000);
        const [recent] = await tx
          .select({ n: count() })
          .from(payments)
          .innerJoin(proposals, eq(proposals.id, payments.proposalId))
          .innerJoin(agentSessions, eq(agentSessions.id, proposals.sessionId))
          .where(
            and(
              eq(agentSessions.userId, session.userId),
              inArray(payments.state, COUNTED_STATES),
              gte(proposals.createdAt, since),
            ),
          );
        ({ outcome, hits } = decideGate('G4', {
          card: cardCheck.card,
          listing: gateListing,
          qty: i.qty,
          now,
          recentPurchaseCount: recent?.n ?? 0,
        }));
      } else {
        outcome = 'block';
        hits = [cardCheck.hit];
      }

      const [proposal] = await tx
        .insert(proposals)
        .values({
          sessionId: session.id,
          ruleCardId: session.ruleCardId,
          listingId: listing.id,
          qty: i.qty,
          idempotencyKey: i.idempotencyKey ?? null,
          rawToolArgs: i.rawArgs ?? {},
          resolvedAmountCents: amountCents,
          resolvedMerchantId: merchant.id,
        })
        .returning({ id: proposals.id });
      if (!proposal) throw new AppError(ErrorCode.INTERNAL, 'Proposal insert returned no row');
      await tx.insert(gateDecisions).values({
        proposalId: proposal.id,
        gate: 'G4',
        outcome,
        ruleHits: hits,
        gateVersion: GATE_VERSION,
      });
      await notify(tx, {
        type: 'proposal.created',
        userId: session.userId,
        proposalId: proposal.id,
        state: outcome,
      });

      const result = {
        proposalId: proposal.id,
        outcome,
        ...(cardCheck.ok ? { card: cardCheck.card } : {}),
        ...(outcome === 'hold'
          ? { anomaly: hits.find((h) => h.rule === 'anomaly') as RuleHit }
          : {}),
      };
      if (outcome === 'block' || session.mode === 'eval') return result;
      if (!merchant.paypalMerchantId) return { ...result, noPayee: true };

      const [vault] = await tx
        .select({ paymentTokenId: vaultTokens.paymentTokenId })
        .from(vaultTokens)
        .where(and(eq(vaultTokens.userId, session.userId), eq(vaultTokens.status, 'active')))
        .limit(1);
      if (!vault) return result;

      const [payment] = await tx
        .insert(payments)
        .values({
          proposalId: proposal.id,
          payeeMerchantId: merchant.id,
          amountCents,
          state: 'authorizing',
        })
        .returning({ id: payments.id });
      if (!payment) throw new AppError(ErrorCode.INTERNAL, 'Payment insert returned no row');
      await tx.insert(paymentEvents).values({
        paymentId: payment.id,
        source: 'api_response',
        type: 'payment.created',
        fromState: null,
        toState: 'authorizing',
        payload: { amountCents, payeeMerchantId: merchant.id },
      });
      await notify(tx, {
        type: 'payment.updated',
        userId: session.userId,
        proposalId: proposal.id,
        paymentId: payment.id,
        state: 'authorizing',
      });
      return {
        ...result,
        payment: {
          id: payment.id,
          vaultId: vault.paymentTokenId,
          payeeId: merchant.paypalMerchantId,
        },
      };
    });
  } catch (err) {
    // A concurrent request with the same Idempotency-Key won the insert: answer with its result.
    if (i.idempotencyKey && isIdempotencyConflict(err)) {
      const existing = await proposalIdForKey(db, session.id, i.idempotencyKey);
      if (existing) return loadProposalResult(db, existing);
    }
    throw err;
  }

  const { proposalId } = recorded;
  // e. Blocked, f. evaluation, or no vault token: nothing more to do, and no PayPal call.
  if (recorded.noPayee) throw missingPayee();
  const payment = recorded.payment;
  if (recorded.outcome === 'block' || session.mode === 'eval' || !payment) {
    return loadProposalResult(db, proposalId);
  }

  // g. Vaulted AUTHORIZE order, payee from the merchant registry.
  assertNotEval(session);
  const ctx = { userId: session.userId, proposalId };
  const createRequestId = `tk-${proposalId}-create`;
  let auth: Awaited<ReturnType<PurchaseDeps['paypal']['createVaultedAuthorization']>>;
  try {
    auth = await deps.paypal.createVaultedAuthorization({
      requestId: createRequestId,
      vaultId: payment.vaultId,
      payeeMerchantId: payment.payeeId,
      referenceId: proposalId,
      amountCents,
      item: {
        name: listing.title.slice(0, PAYPAL_ITEM_NAME_MAX),
        sku: listing.id,
        qty: i.qty,
        unitAmountCents: listing.priceCents,
      },
    });
  } catch (err) {
    // j. PayPal refused or was unreachable: nothing was authorized.
    log.warn({ proposalId, paymentId: payment.id, err: errorPayload(err) }, 'authorization failed');
    await movePayment(db, payment.id, {
      ...ctx,
      from: 'authorizing',
      to: 'failed',
      type: 'paypal.error',
      requestId: createRequestId,
      payload: errorPayload(err),
    });
    return loadProposalResult(db, proposalId);
  }

  await movePayment(db, payment.id, {
    ...ctx,
    from: 'authorizing',
    to: 'authorized',
    type: 'authorization.created',
    requestId: createRequestId,
    payload: {
      orderId: auth.orderId,
      orderStatus: auth.orderStatus,
      authorizationId: auth.authorizationId,
      authorizationStatus: auth.authorizationStatus,
    },
    set: {
      paypalOrderId: auth.orderId,
      paypalAuthorizationId: auth.authorizationId,
      honorExpiresAt: new Date(now.getTime() + HONOR_PERIOD_MS),
      authExpiresAt: new Date(now.getTime() + AUTHORIZATION_MS),
    },
  });

  if (recorded.outcome === 'hold') {
    // i. Anomalous: keep the authorization as a hold until the human decides or it times out.
    const card = recorded.card as RuleCard;
    const demo = session.mode === 'demo' || session.mode === 'hijack';
    const minutes =
      demo && deps.demoHoldMinutes !== undefined ? deps.demoHoldMinutes : card.holdTimeoutMinutes;
    const deadline = new Date(now.getTime() + minutes * 60_000);
    await movePayment(db, payment.id, {
      ...ctx,
      from: 'authorized',
      to: 'held',
      type: 'hold.created',
      payload: { holdDeadlineAt: deadline.toISOString() },
      set: { holdDeadlineAt: deadline },
      after: async (tx) => {
        await tx.insert(approvals).values({
          paymentId: payment.id,
          userId: session.userId,
          status: 'pending',
          reason: recorded.anomaly?.detail ?? {},
          deadlineAt: deadline,
        });
      },
    });
    // The timer voids the hold at its deadline; if this send fails, the sweep still voids it.
    await scheduleHoldTimeout(deps, payment.id, deadline);
    return loadProposalResult(db, proposalId);
  }

  // h. Clean: capture. The move to capture_requested happens under a row lock first, so a
  // capture is never issued twice for one payment.
  assertNotEval(session);
  const captureRequestId = `tk-${proposalId}-capture`;
  await movePayment(db, payment.id, {
    ...ctx,
    from: 'authorized',
    to: 'capture_requested',
    type: 'capture.requested',
    requestId: captureRequestId,
  });
  let capture: Awaited<ReturnType<PurchaseDeps['paypal']['capture']>>;
  try {
    capture = await deps.paypal.capture({
      authorizationId: auth.authorizationId,
      requestId: captureRequestId,
    });
  } catch (err) {
    log.warn({ proposalId, paymentId: payment.id, err: errorPayload(err) }, 'capture failed');
    await movePayment(db, payment.id, {
      ...ctx,
      from: 'capture_requested',
      to: 'failed',
      type: 'paypal.error',
      requestId: captureRequestId,
      payload: errorPayload(err),
    });
    return loadProposalResult(db, proposalId);
  }

  if (capture.status === 'COMPLETED') {
    await movePayment(db, payment.id, {
      ...ctx,
      from: 'capture_requested',
      to: 'captured',
      type: 'capture.completed',
      requestId: captureRequestId,
      payload: { captureId: capture.captureId, status: capture.status },
      set: { paypalCaptureId: capture.captureId },
    });
  } else {
    // PENDING (or anything else): stay in capture_requested; the webhook finishes it.
    await db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({ paypalCaptureId: capture.captureId || null, updatedAt: sql`now()` })
        .where(eq(payments.id, payment.id));
      await tx.insert(paymentEvents).values({
        paymentId: payment.id,
        source: 'api_response',
        type: 'capture.pending',
        fromState: 'capture_requested',
        toState: 'capture_requested',
        requestId: captureRequestId,
        payload: { captureId: capture.captureId, status: capture.status },
      });
    });
  }
  return loadProposalResult(db, proposalId);
}
