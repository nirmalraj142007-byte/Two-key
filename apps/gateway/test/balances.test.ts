import { randomUUID } from 'node:crypto';
import {
  agentSessions,
  createDb,
  listings,
  merchants,
  payments,
  proposals,
  ruleCards,
  users,
} from '@twokey/db';
import { createTestDatabase, runSeed, testDatabaseUrl } from '@twokey/db/testing';
import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  createBalanceService,
  type MerchantBalance,
  maskMerchantId,
  transactionWindow,
  usdBalanceCents,
} from '../src/services/balances.js';

const baseUrl = testDatabaseUrl();
const silent = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
} as unknown as FastifyBaseLogger;

describe('balance helpers', () => {
  it('queries from Oct 19 to now, never more than 31 days', () => {
    expect(transactionWindow(new Date('2026-10-27T10:00:00.123Z'))).toEqual({
      start: '2026-10-19T00:00:00Z',
      end: '2026-10-27T10:00:00Z',
    });
    expect(transactionWindow(new Date('2026-12-31T00:00:00Z'))).toEqual({
      start: '2026-11-30T00:00:00Z',
      end: '2026-12-31T00:00:00Z',
    });
  });

  it('masks merchant IDs to the last 4 characters', () => {
    expect(maskMerchantId('KJ5QLMZCN224U')).toBe('•••••••••224U');
    expect(maskMerchantId(null)).toBeNull();
  });

  it('reads the USD total from a reporting/balances body', () => {
    const body = {
      balances: [
        { currency: 'EUR', total_balance: { currency_code: 'EUR', value: '9.00' } },
        { currency: 'USD', total_balance: { currency_code: 'USD', value: '52.13' } },
      ],
    };
    expect(usdBalanceCents(body)).toBe(5213);
    expect(usdBalanceCents({ balances: [] })).toBeNull();
    expect(usdBalanceCents({ nope: true })).toBeNull();
    expect(
      usdBalanceCents({
        balances: [{ currency: 'USD', total_balance: { currency_code: 'USD', value: '-1.00' } }],
      }),
    ).toBeNull();
  });
});

describe.skipIf(!baseUrl)('merchant balances', () => {
  let drop = async () => {};
  let dbUrl = '';
  let conn: ReturnType<typeof createDb>;

  /** A captured purchase to `slug`, written straight to the tables. */
  async function captured(slug: string, cents: number, state: 'captured' | 'held' = 'captured') {
    const [user] = await conn.db
      .insert(users)
      .values({ email: `${randomUUID()}@example.test`, displayName: 'Test' })
      .returning({ id: users.id });
    const userId = (user as { id: string }).id;
    const [merchant] = await conn.db
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.slug, slug));
    const merchantId = (merchant as { id: string }).id;
    const [listing] = await conn.db
      .select({ id: listings.id })
      .from(listings)
      .where(eq(listings.merchantId, merchantId))
      .limit(1);
    const [card] = await conn.db
      .insert(ruleCards)
      .values({ userId, version: 1, status: 'draft', nlRequest: 't', rules: {}, enforcement: {} })
      .returning({ id: ruleCards.id });
    const cardId = (card as { id: string }).id;
    const [session] = await conn.db
      .insert(agentSessions)
      .values({
        userId,
        ruleCardId: cardId,
        mode: 'demo',
        model: 't',
        agentTokenHash: randomUUID(),
      })
      .returning({ id: agentSessions.id });
    const [proposal] = await conn.db
      .insert(proposals)
      .values({
        sessionId: (session as { id: string }).id,
        ruleCardId: cardId,
        listingId: (listing as { id: string }).id,
        qty: 1,
        rawToolArgs: {},
        resolvedAmountCents: cents,
        resolvedMerchantId: merchantId,
      })
      .returning({ id: proposals.id });
    await conn.db.insert(payments).values({
      proposalId: (proposal as { id: string }).id,
      payeeMerchantId: merchantId,
      amountCents: cents,
      state,
    });
  }

  beforeAll(async () => {
    ({ url: dbUrl, drop } = await createTestDatabase(baseUrl as string));
    await runSeed(dbUrl);
    conn = createDb(dbUrl);
    await captured('stride-supply', 5400);
    await captured('stride-supply', 5400);
    await captured('peak-outfitters', 6440, 'held');
  });

  afterAll(async () => {
    await conn?.sql.end();
    await drop();
  });

  function bySlug(items: MerchantBalance[], slug: string) {
    const item = items.find((i) => i.slug === slug);
    if (!item) throw new Error(`missing ${slug}`);
    return item;
  }

  it('sums captured payments only, and computes when no credentials are set', async () => {
    const calls: string[] = [];
    const svc = createBalanceService({
      db: conn.db,
      credentials: undefined,
      env: 'sandbox',
      log: silent,
      fetch: async (url) => {
        calls.push(String(url));
        throw new Error('no fetch expected');
      },
    });
    const items = await svc.list();
    expect(calls).toEqual([]);
    expect(items.map((i) => i.slug).sort()).toEqual([
      'corner-pantry',
      'giftvault',
      'pacer-goods',
      'peak-outfitters',
      'stride-supply',
    ]);
    expect(bySlug(items, 'stride-supply')).toMatchObject({
      grossCapturedCents: 10800,
      paypalBalanceCents: null,
      source: 'computed',
    });
    // A held authorization is not money received.
    expect(bySlug(items, 'peak-outfitters').grossCapturedCents).toBe(0);
    const gift = bySlug(items, 'giftvault');
    expect(gift).toMatchObject({ role: 'attacker', grossCapturedCents: 0, source: 'computed' });
    expect(gift.paypalMerchantId).toMatch(/^•+[A-Z0-9]{4}$/);
  });

  it('uses PayPal where it answers, falls back where refused, and caches for 30 s', async () => {
    let t = Date.parse('2026-10-27T10:00:00Z');
    const calls: string[] = [];
    const windows: string[] = [];
    const svc = createBalanceService({
      db: conn.db,
      credentials: {
        'stride-supply': { clientId: 'a', clientSecret: 'b' },
        giftvault: { clientId: 'c', clientSecret: 'd' },
      },
      env: 'sandbox',
      log: silent,
      now: () => new Date(t),
      fetch: async (input, init) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/v1/oauth2/token')) {
          const basic = String(
            (init?.headers as Record<string, string> | undefined)?.authorization,
          );
          const id = Buffer.from(basic.slice(6), 'base64').toString().split(':')[0];
          return Response.json({ access_token: `tok-${id}`, expires_in: 3600 });
        }
        const auth = String((init?.headers as Record<string, string> | undefined)?.authorization);
        if (url.includes('/v1/reporting/transactions')) {
          const q = new URL(url).searchParams;
          windows.push(`${q.get('start_date')}..${q.get('end_date')}`);
          if (auth !== 'Bearer tok-a') {
            return Response.json({ transaction_details: [], total_pages: 0 });
          }
          const tx = (status: string, value: string) => ({
            transaction_info: {
              transaction_status: status,
              transaction_amount: { currency_code: 'USD', value },
            },
          });
          return q.get('page') === '1'
            ? Response.json({
                transaction_details: [tx('S', '54.00'), tx('S', '-2.07'), tx('P', '54.00')],
                total_pages: 2,
                last_refreshed_datetime: '2026-10-27T09:59:59Z',
              })
            : Response.json({ transaction_details: [tx('S', '54.00')], total_pages: 2 });
        }
        if (auth === 'Bearer tok-a') {
          return Response.json({
            balances: [
              { currency: 'USD', total_balance: { currency_code: 'USD', value: '104.53' } },
            ],
          });
        }
        return Response.json({ name: 'NOT_AUTHORIZED' }, { status: 403 });
      },
    });
    const items = await svc.list();
    expect(bySlug(items, 'stride-supply')).toMatchObject({
      grossCapturedCents: 10800,
      paypalBalanceCents: 10453,
      // Completed and incoming only, across both pages.
      paypalPaymentsReceived: 2,
      paypalTransactionsAsOf: '2026-10-27T09:59:59Z',
      source: 'paypal',
    });
    expect(windows[0]).toBe('2026-10-19T00:00:00Z..2026-10-27T10:00:00Z');
    // Balance refused but Transaction Search answered: the count still shows.
    expect(bySlug(items, 'giftvault')).toMatchObject({
      grossCapturedCents: 0,
      paypalBalanceCents: null,
      paypalPaymentsReceived: 0,
      source: 'computed',
    });
    // No credentials: no PayPal figures at all.
    expect(bySlug(items, 'pacer-goods')).toMatchObject({
      paypalPaymentsReceived: null,
      paypalTransactionsAsOf: null,
    });
    expect(calls.filter((c) => c.includes('/v1/reporting/balances'))).toHaveLength(2);

    t += 10_000;
    await svc.list();
    expect(calls.filter((c) => c.includes('/v1/reporting/balances'))).toHaveLength(2);

    t += 30_000;
    await svc.list();
    expect(calls.filter((c) => c.includes('/v1/reporting/balances'))).toHaveLength(4);
    // The OAuth token is reused.
    expect(calls.filter((c) => c.endsWith('/v1/oauth2/token'))).toHaveLength(2);
  });

  it('does not break when PayPal is unreachable', async () => {
    const svc = createBalanceService({
      db: conn.db,
      credentials: { 'stride-supply': { clientId: 'a', clientSecret: 'b' } },
      env: 'sandbox',
      log: silent,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const items = await svc.list();
    expect(bySlug(items, 'stride-supply')).toMatchObject({
      grossCapturedCents: 10800,
      source: 'computed',
    });
  });

  describe('GET /human/merchants/balances', () => {
    let app: FastifyInstance;
    let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
    let userId = '';

    async function assertion(scope: string): Promise<string> {
      const iat = Math.floor(Date.now() / 1000);
      return new SignJWT({ role: 'user', scope })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setIssuer('twokey-web')
        .setAudience('twokey-gateway')
        .setSubject(userId)
        .setJti(randomUUID())
        .setIssuedAt(iat)
        .setExpirationTime(iat + 60)
        .sign(privateKey);
    }

    beforeAll(async () => {
      const pair = await generateKeyPair('EdDSA', { extractable: true });
      privateKey = pair.privateKey;
      const [user] = await conn.db
        .insert(users)
        .values({ email: `${randomUUID()}@example.test`, displayName: 'Test' })
        .returning({ id: users.id });
      userId = (user as { id: string }).id;
      const noPayPal = async (): Promise<never> => {
        throw new Error('PayPal must not be called');
      };
      app = buildApp(
        {
          LOG_LEVEL: 'silent',
          DATABASE_URL: dbUrl,
          RULE_HMAC_KEY: Buffer.alloc(32, 1).toString('base64'),
          RULE_HMAC_KEY_ID: 'test-key',
          AGENT_TOKEN_PEPPER: 'test-pepper',
          HUMAN_ASSERTION_PUBLIC_KEY: await exportSPKI(pair.publicKey),
          WEB_ORIGIN: 'http://localhost:3000',
        },
        {
          balances: createBalanceService({
            db: conn.db,
            credentials: undefined,
            env: 'sandbox',
            log: silent,
          }),
          jobs: { send: async () => {} },
          vault: {
            createSetupToken: noPayPal,
            createPaymentToken: noPayPal,
            deletePaymentToken: noPayPal,
          },
        },
      );
      await app.ready();
    });

    afterAll(async () => {
      await app?.close();
    });

    it('needs an events:read human assertion', async () => {
      const none = await app.inject({ url: '/human/merchants/balances' });
      expect(none.statusCode).toBe(401);
      const agent = await app.inject({
        url: '/human/merchants/balances',
        headers: { authorization: 'Bearer tk_agent_abc' },
      });
      expect(agent.statusCode).toBe(401);
      const wrongScope = await app.inject({
        url: '/human/merchants/balances',
        headers: { authorization: `Bearer ${await assertion('approvals:decide')}` },
      });
      expect(wrongScope.statusCode).toBe(403);
    });

    it('lists the five sandbox merchants with GiftVault at $0.00', async () => {
      const res = await app.inject({
        url: '/human/merchants/balances',
        headers: { authorization: `Bearer ${await assertion('events:read')}` },
      });
      expect(res.statusCode).toBe(200);
      const { items } = res.json() as { items: MerchantBalance[] };
      expect(items).toHaveLength(5);
      expect(bySlug(items, 'giftvault')).toMatchObject({ grossCapturedCents: 0 });
      expect(bySlug(items, 'stride-supply')).toMatchObject({ grossCapturedCents: 10800 });
      expect(JSON.stringify(items)).not.toContain('KJ5QLMZCN224U');
    });
  });

  it('keeps eval-only merchants off the list', async () => {
    const rows = await conn.db
      .select({ slug: merchants.slug })
      .from(merchants)
      .where(and(eq(merchants.role, 'eval_merchant')));
    const svc = createBalanceService({
      db: conn.db,
      credentials: undefined,
      env: 'sandbox',
      log: silent,
    });
    const slugs = new Set((await svc.list()).map((i) => i.slug));
    for (const r of rows) expect(slugs.has(r.slug)).toBe(false);
  });
});
