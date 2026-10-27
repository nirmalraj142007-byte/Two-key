import { toCents } from '@twokey/core';
import { type Db, merchants, payments } from '@twokey/db';
import { type MerchantCredentials, PAYPAL_BASE_URL } from '@twokey/paypal';
import { and, eq, inArray, sum } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

/**
 * Merchant balances for the /merchants page. The main figure is the gross amount Two-Key
 * captured to each payee, from its own payments table. PayPal's own balance (net of fees, and
 * including anything the sandbox account received outside Two-Key) is shown beside it when the
 * merchant's REST app may read it (GET /v1/reporting/balances); otherwise it is null and the
 * row is marked 'computed'. The count of payments the account received comes from PayPal's
 * Transaction Search (GET /v1/reporting/transactions), which can lag by a few hours.
 */

export interface MerchantBalance {
  slug: string;
  displayName: string;
  role: 'allowed_demo' | 'attacker';
  /** Masked to the last 4 characters. */
  paypalMerchantId: string | null;
  /** Gross captured to this payee by Two-Key (all users), in cents. */
  grossCapturedCents: number;
  /** PayPal's reported total balance (after fees), in cents; null when PayPal didn't give one. */
  paypalBalanceCents: number | null;
  /** Completed incoming payments since TRANSACTIONS_SINCE, from Transaction Search; null if unavailable. */
  paypalPaymentsReceived: number | null;
  /** When PayPal last refreshed its transaction log (last_refreshed_datetime); null if unknown. */
  paypalTransactionsAsOf: string | null;
  /** 'paypal' when paypalBalanceCents came from PayPal; 'computed' when only Two-Key records. */
  source: 'paypal' | 'computed';
  asOf: string;
}

export interface BalanceServiceOptions {
  db: Db;
  /** MERCHANT_API_CREDENTIALS, by merchant slug. */
  credentials: Record<string, MerchantCredentials> | undefined;
  env: 'sandbox' | 'live';
  log: FastifyBaseLogger;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface BalanceService {
  list(): Promise<MerchantBalance[]>;
}

const CACHE_MS = 30_000;
const TIMEOUT_MS = 5_000;
const SHOWN_ROLES = ['allowed_demo', 'attacker'] as const;
/** Start of the demo's sandbox payments; Transaction Search allows at most 31 days per query. */
export const TRANSACTIONS_SINCE = '2026-10-19T00:00:00Z';
const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 500;
const MAX_PAGES = 10;

const TokenResponse = z.object({ access_token: z.string().min(1), expires_in: z.number() });
const Money = z.object({ currency_code: z.string(), value: z.string() });
const BalancesResponse = z.object({
  balances: z.array(
    z.object({
      currency: z.string(),
      total_balance: Money.optional(),
      available_balance: Money.optional(),
    }),
  ),
});

const TransactionsResponse = z.object({
  transaction_details: z
    .array(
      z.object({
        transaction_info: z.object({
          transaction_status: z.string().optional(),
          transaction_amount: Money.optional(),
        }),
      }),
    )
    .default([]),
  total_pages: z.number().int().nonnegative().default(0),
  last_refreshed_datetime: z.string().optional(),
});

/** PayPal wants ISO 8601 without milliseconds. */
function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The query window: TRANSACTIONS_SINCE to now, cut to PayPal's 31-day maximum. */
export function transactionWindow(now: Date): { start: string; end: string } {
  const since = Date.parse(TRANSACTIONS_SINCE);
  const start = new Date(Math.max(since, now.getTime() - MAX_RANGE_MS));
  return { start: isoSeconds(start), end: isoSeconds(now) };
}

/** Completed (status S) incoming (positive amount) payments in one Transaction Search page. */
export function countReceived(body: z.infer<typeof TransactionsResponse>): number {
  return body.transaction_details.filter((d) => {
    const amount = Number(d.transaction_info.transaction_amount?.value);
    return d.transaction_info.transaction_status === 'S' && amount > 0;
  }).length;
}

/** 'KJ5QLMZCN224U' -> '•••••••••224U'. */
export function maskMerchantId(id: string | null): string | null {
  if (!id) return null;
  return id.length <= 4 ? id : `${'•'.repeat(id.length - 4)}${id.slice(-4)}`;
}

/** The USD total from a /v1/reporting/balances body, in cents; null if absent or unparseable. */
export function usdBalanceCents(body: unknown): number | null {
  const parsed = BalancesResponse.safeParse(body);
  if (!parsed.success) return null;
  const usd = parsed.data.balances.find((b) => b.currency === 'USD');
  const money = usd?.total_balance ?? usd?.available_balance;
  if (money?.currency_code !== 'USD') return null;
  try {
    return toCents(money.value);
  } catch {
    return null;
  }
}

export function createBalanceService(opts: BalanceServiceOptions): BalanceService {
  const { log } = opts;
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  const base = PAYPAL_BASE_URL[opts.env];
  const tokens = new Map<string, { token: string; expiresAt: number }>();
  // slug -> PayPal figures (nulls after a refusal), kept 30 s either way.
  const cache = new Map<string, { figures: PayPalFigures; at: number }>();

  async function token(slug: string, c: MerchantCredentials): Promise<string> {
    const hit = tokens.get(slug);
    if (hit && hit.expiresAt > now().getTime()) return hit.token;
    const res = await doFetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`oauth ${res.status}`);
    const body = TokenResponse.parse(await res.json());
    // Refresh a minute early.
    tokens.set(slug, {
      token: body.access_token,
      expiresAt: now().getTime() + Math.max(0, body.expires_in - 60) * 1000,
    });
    return body.access_token;
  }

  interface PayPalFigures {
    balanceCents: number | null;
    received: number | null;
    transactionsAsOf: string | null;
  }
  const NONE: PayPalFigures = { balanceCents: null, received: null, transactionsAsOf: null };

  async function balance(slug: string, bearer: string): Promise<number | null> {
    const res = await doFetch(`${base}/v1/reporting/balances?currency_code=USD`, {
      headers: { authorization: bearer },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return usdBalanceCents(await res.json());
    // Usually 403: the app lacks the reporting permission. The computed figure stands.
    log.warn(
      { merchant: slug, status: res.status, debugId: res.headers.get('paypal-debug-id') },
      'paypal balance unavailable',
    );
    return null;
  }

  async function received(
    slug: string,
    bearer: string,
  ): Promise<Pick<PayPalFigures, 'received' | 'transactionsAsOf'>> {
    const { start, end } = transactionWindow(now());
    let count = 0;
    let asOf: string | null = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const q = new URLSearchParams({
        start_date: start,
        end_date: end,
        fields: 'transaction_info',
        page_size: String(PAGE_SIZE),
        page: String(page),
      });
      const res = await doFetch(`${base}/v1/reporting/transactions?${q}`, {
        headers: { authorization: bearer },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        log.warn(
          { merchant: slug, status: res.status, debugId: res.headers.get('paypal-debug-id') },
          'paypal transactions unavailable',
        );
        return { received: null, transactionsAsOf: null };
      }
      const parsed = TransactionsResponse.safeParse(await res.json());
      if (!parsed.success) return { received: null, transactionsAsOf: null };
      count += countReceived(parsed.data);
      asOf ??= parsed.data.last_refreshed_datetime ?? null;
      if (page >= parsed.data.total_pages) break;
    }
    return { received: count, transactionsAsOf: asOf };
  }

  async function paypalFigures(slug: string): Promise<PayPalFigures> {
    const c =
      opts.credentials && Object.hasOwn(opts.credentials, slug)
        ? opts.credentials[slug]
        : undefined;
    if (!c) return NONE;
    const cached = cache.get(slug);
    if (cached && now().getTime() - cached.at < CACHE_MS) return cached.figures;
    let figures = NONE;
    try {
      const bearer = `Bearer ${await token(slug, c)}`;
      // Each call fails on its own: a refused balance still shows the payment count.
      const [b, r] = await Promise.all([
        balance(slug, bearer).catch((err: Error) => {
          log.warn({ merchant: slug, err: err.message }, 'paypal balance unavailable');
          return null;
        }),
        received(slug, bearer).catch((err: Error) => {
          log.warn({ merchant: slug, err: err.message }, 'paypal transactions unavailable');
          return { received: null, transactionsAsOf: null };
        }),
      ]);
      figures = { balanceCents: b, ...r };
    } catch (err) {
      log.warn({ merchant: slug, err: (err as Error).message }, 'paypal balance unavailable');
    }
    cache.set(slug, { figures, at: now().getTime() });
    return figures;
  }

  return {
    async list() {
      // Read lazily: the gateway's db decorator exists only once the app is ready.
      const db = opts.db;
      const [rows, captured] = await Promise.all([
        db
          .select({
            id: merchants.id,
            slug: merchants.slug,
            displayName: merchants.displayName,
            role: merchants.role,
            paypalMerchantId: merchants.paypalMerchantId,
          })
          .from(merchants)
          .where(inArray(merchants.role, [...SHOWN_ROLES]))
          .orderBy(merchants.displayName),
        db
          .select({ merchantId: payments.payeeMerchantId, cents: sum(payments.amountCents) })
          .from(payments)
          .where(and(eq(payments.state, 'captured'), eq(payments.currency, 'USD')))
          .groupBy(payments.payeeMerchantId),
      ]);
      const gross = new Map(captured.map((r) => [r.merchantId, Number(r.cents ?? 0)]));
      const asOf = now().toISOString();
      return Promise.all(
        rows.map(async (m): Promise<MerchantBalance> => {
          const pp = await paypalFigures(m.slug);
          return {
            slug: m.slug,
            displayName: m.displayName,
            role: m.role as MerchantBalance['role'],
            paypalMerchantId: maskMerchantId(m.paypalMerchantId),
            grossCapturedCents: gross.get(m.id) ?? 0,
            paypalBalanceCents: pp.balanceCents,
            paypalPaymentsReceived: pp.received,
            paypalTransactionsAsOf: pp.transactionsAsOf,
            source: pp.balanceCents === null ? 'computed' : 'paypal',
            asOf,
          };
        }),
      );
    },
  };
}
