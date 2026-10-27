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
 * row is marked 'computed'.
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
  // slug -> PayPal balance (or null after a refusal), kept 30 s either way.
  const cache = new Map<string, { cents: number | null; at: number }>();

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

  async function paypalBalance(slug: string): Promise<number | null> {
    const c =
      opts.credentials && Object.hasOwn(opts.credentials, slug)
        ? opts.credentials[slug]
        : undefined;
    if (!c) return null;
    const cached = cache.get(slug);
    if (cached && now().getTime() - cached.at < CACHE_MS) return cached.cents;
    let cents: number | null = null;
    try {
      const res = await doFetch(`${base}/v1/reporting/balances?currency_code=USD`, {
        headers: { authorization: `Bearer ${await token(slug, c)}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        cents = usdBalanceCents(await res.json());
      } else {
        // Usually 403: the app lacks the reporting permission. The computed figure stands.
        log.warn(
          { merchant: slug, status: res.status, debugId: res.headers.get('paypal-debug-id') },
          'paypal balance unavailable',
        );
      }
    } catch (err) {
      log.warn({ merchant: slug, err: (err as Error).message }, 'paypal balance unavailable');
    }
    cache.set(slug, { cents, at: now().getTime() });
    return cents;
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
          const paypalBalanceCents = await paypalBalance(m.slug);
          return {
            slug: m.slug,
            displayName: m.displayName,
            role: m.role as MerchantBalance['role'],
            paypalMerchantId: maskMerchantId(m.paypalMerchantId),
            grossCapturedCents: gross.get(m.id) ?? 0,
            paypalBalanceCents,
            source: paypalBalanceCents === null ? 'computed' : 'paypal',
            asOf,
          };
        }),
      );
    },
  };
}
