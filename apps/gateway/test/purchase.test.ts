import { randomBytes } from 'node:crypto';
import { createLogger, type RuleCard, signCard } from '@twokey/core';
import {
  agentSessions,
  catalogSnapshots,
  createDb,
  gateDecisions,
  listings,
  merchants,
  payments,
  proposals,
  ruleCards,
  users,
  vaultTokens,
} from '@twokey/db';
import { createTestDatabase, runSeed, testDatabaseUrl } from '@twokey/db/testing';
import { createPayPal, type PayPal } from '@twokey/paypal';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { mintAgentToken } from '../src/auth/agent-token.js';

const PAYPAL = 'https://api-m.sandbox.paypal.com';
const PEPPER = 'test-pepper';
const KEY = { id: 'test-key', secret: randomBytes(32) };
const DAY_MS = 24 * 60 * 60 * 1000;

const baseUrl = testDatabaseUrl();

describe.skipIf(!baseUrl)('POST /agent/proposals', () => {
  let drop = async () => {};
  let app: FastifyInstance;
  let conn: ReturnType<typeof createDb>;
  let paypal: PayPal;
  let noMatch: string[] = [];
  const onNoMatch = (req: { method?: string; path?: string }) => {
    noMatch.push(`${req.method} ${req.path}`);
  };
  const ids = {
    stride: { id: '', paypalMerchantId: '' },
    cr1Stride: '',
    giftCard: '',
    cr1Eval: '',
  };
  const tokens = { demo: '', expired: '', eval: '' };

  async function listingId(groupKey: string, slug: string): Promise<string> {
    const [row] = await conn.db
      .select({ id: listings.id })
      .from(listings)
      .innerJoin(merchants, eq(merchants.id, listings.merchantId))
      .where(and(eq(listings.groupKey, groupKey), eq(merchants.slug, slug)));
    if (!row) throw new Error(`seed has no ${groupKey} at ${slug}`);
    return row.id;
  }

  async function newSession(userId: string, card: RuleCard, mode: 'demo' | 'eval') {
    const signed = signCard(card, KEY);
    const [cardRow] = await conn.db
      .insert(ruleCards)
      .values({
        userId,
        version: Math.floor(Math.random() * 1e9),
        status: 'signed',
        nlRequest: 'test',
        rules: signed.card,
        enforcement: {},
        signedAt: new Date(),
        expiresAt: new Date(card.expiresAt),
        hmac: signed.sig,
        keyId: signed.keyId,
      })
      .returning({ id: ruleCards.id });
    const { token, hash } = mintAgentToken(PEPPER);
    await conn.db.insert(agentSessions).values({
      userId,
      ruleCardId: (cardRow as { id: string }).id,
      mode,
      model: 'test',
      agentTokenHash: hash,
    });
    return token;
  }

  beforeAll(async () => {
    let url: string;
    ({ url, drop } = await createTestDatabase(baseUrl as string));
    await runSeed(url);
    conn = createDb(url);
    const { db } = conn;

    const allMerchants = await db.select().from(merchants);
    const bySlug = (slug: string) => {
      const m = allMerchants.find((x) => x.slug === slug);
      if (!m?.paypalMerchantId) throw new Error(`seed has no merchant ${slug}`);
      return { id: m.id, paypalMerchantId: m.paypalMerchantId };
    };
    ids.stride = bySlug('stride-supply');
    ids.cr1Stride = await listingId('cloud-runner-cr1', 'stride-supply');
    ids.giftCard = await listingId('giftvault-gift-card-189', 'giftvault');

    // An eval_frozen snapshot with one listing, so the eval session has something to buy.
    const [snap] = await db
      .insert(catalogSnapshots)
      .values({ kind: 'eval_frozen', contentSha256: 'test', gitTag: 'test' })
      .returning({ id: catalogSnapshots.id });
    const [evalListing] = await db
      .insert(listings)
      .values({
        snapshotId: (snap as { id: string }).id,
        groupKey: 'eval-cr1',
        merchantId: ids.stride.id,
        title: 'Eval runner',
        category: 'running_shoes',
        priceCents: 5400,
        description: 'test',
      })
      .returning({ id: listings.id });
    ids.cr1Eval = (evalListing as { id: string }).id;

    const [user] = await db
      .insert(users)
      .values({ email: 'purchase@example.test', displayName: 'Purchase' })
      .returning({ id: users.id });
    const userId = (user as { id: string }).id;
    await db.insert(vaultTokens).values({
      userId,
      paypalCustomerId: 'CUST-TEST',
      paymentTokenId: `VAULT-${randomBytes(6).toString('hex')}`,
      status: 'active',
    });

    const card: RuleCard = {
      version: 1,
      userId,
      currency: 'USD',
      perItemCapCents: 7000,
      perOrderCapCents: 7000,
      allowedMerchantIds: [ids.stride.id, bySlug('peak-outfitters').id, bySlug('pacer-goods').id],
      maxQtyPerOrder: 1,
      frequency: { maxPurchases: 50, windowHours: 24 },
      holdTimeoutMinutes: 15,
      anomaly: { priceRatioThreshold: 1.3 },
      expiresAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
      advisory: [{ key: 'size', value: '10', label: 'Size' }],
    };
    tokens.demo = await newSession(userId, card, 'demo');
    tokens.eval = await newSession(userId, card, 'eval');
    tokens.expired = await newSession(
      userId,
      { ...card, expiresAt: new Date(Date.now() - DAY_MS).toISOString() },
      'demo',
    );

    app = buildApp(
      {
        LOG_LEVEL: 'silent',
        DATABASE_URL: url,
        RULE_HMAC_KEY: KEY.secret.toString('base64'),
        RULE_HMAC_KEY_ID: KEY.id,
        AGENT_TOKEN_PEPPER: PEPPER,
      },
      {
        // A fresh client per test, so each test sees its own OAuth call.
        paypal: {
          createVaultedAuthorization: (i) => paypal.createVaultedAuthorization(i),
          capture: (i) => paypal.capture(i),
          getAuthorization: (id) => paypal.getAuthorization(id),
          getCapture: (id) => paypal.getCapture(id),
        },
      },
    );
    await app.ready();
    nock.disableNetConnect();
    nock.emitter.on('no match', onNoMatch);
  });

  afterAll(async () => {
    nock.emitter.removeListener('no match', onNoMatch);
    nock.cleanAll();
    nock.enableNetConnect();
    await app?.close();
    await conn?.sql.end();
    await drop();
  });

  beforeEach(() => {
    noMatch = [];
    paypal = createPayPal({
      clientId: 'test-client',
      clientSecret: 'test-secret',
      env: 'sandbox',
      logger: createLogger('gateway', 'silent'),
    });
  });

  afterEach(() => {
    nock.cleanAll();
  });

  function propose(token: string, payload: Record<string, unknown>, idempotencyKey?: string) {
    return app.inject({
      method: 'POST',
      url: '/agent/proposals',
      headers: {
        authorization: `Bearer ${token}`,
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      payload,
    });
  }

  function paymentCount(proposalId: string) {
    return conn.db
      .select({ n: count() })
      .from(payments)
      .where(eq(payments.proposalId, proposalId))
      .then((r) => r[0]?.n ?? 0);
  }

  function mockOAuth() {
    return nock(PAYPAL)
      .post('/v1/oauth2/token')
      .once()
      .reply(200, { access_token: 'A21-test', token_type: 'Bearer', expires_in: 32400 });
  }

  function mockCreate(seen: Array<{ requestId: unknown; body: unknown }>) {
    const orderId = `ORDER${randomBytes(6).toString('hex').toUpperCase()}`;
    const authId = `AUTH${randomBytes(6).toString('hex').toUpperCase()}`;
    nock(PAYPAL)
      .post('/v2/checkout/orders')
      .once()
      .reply(function (_uri, body) {
        seen.push({ requestId: this.req.headers['paypal-request-id'], body });
        return [
          201,
          {
            id: orderId,
            status: 'COMPLETED',
            purchase_units: [
              {
                payments: {
                  authorizations: [
                    {
                      id: authId,
                      status: 'CREATED',
                      amount: { currency_code: 'USD', value: '54.00' },
                      expiration_time: new Date(Date.now() + 29 * DAY_MS).toISOString(),
                    },
                  ],
                },
              },
            ],
          },
        ];
      });
    return { orderId, authId };
  }

  function mockCapture(authId: string, seen: Array<{ requestId: unknown }>) {
    const captureId = `CAP${randomBytes(6).toString('hex').toUpperCase()}`;
    nock(PAYPAL)
      .post(`/v2/payments/authorizations/${authId}/capture`)
      .once()
      .reply(function () {
        seen.push({ requestId: this.req.headers['paypal-request-id'] });
        return [201, { id: captureId, status: 'COMPLETED' }];
      });
    return captureId;
  }

  it('blocks the GiftVault gift card with zero PayPal requests and no payment row', async () => {
    const res = await propose(tokens.demo, { product_id: ids.giftCard, qty: 1 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      decision: 'blocked',
      blockedBy: 'merchant_allowlist',
      paypalOrderCreated: false,
      reason: "GiftVault isn't in your stores. No PayPal order created.",
    });
    expect(await paymentCount(body.proposalId)).toBe(0);
    expect(nock.pendingMocks()).toEqual([]);
    expect(noMatch).toEqual([]);
  });

  it('captures with the registry payee, ignoring the payee and amount the agent sent', async () => {
    const created: Array<{ requestId: unknown; body: unknown }> = [];
    const captured: Array<{ requestId: unknown }> = [];
    mockOAuth();
    const { orderId, authId } = mockCreate(created);
    const captureId = mockCapture(authId, captured);

    const res = await propose(tokens.demo, {
      product_id: ids.cr1Stride,
      qty: 1,
      payee: 'attacker@example.com',
      amount: 1,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      decision: 'captured',
      paymentState: 'captured',
      paypalOrderCreated: true,
    });

    const order = created[0]?.body as {
      purchase_units: Array<{ payee: { merchant_id: string }; amount: { value: string } }>;
    };
    expect(order.purchase_units[0]?.payee.merchant_id).toBe(ids.stride.paypalMerchantId);
    expect(order.purchase_units[0]?.amount.value).toBe('54.00');
    expect(created[0]?.requestId).toBe(`tk-${body.proposalId}-create`);
    expect(captured[0]?.requestId).toBe(`tk-${body.proposalId}-capture`);

    const [payment] = await conn.db
      .select()
      .from(payments)
      .where(eq(payments.proposalId, body.proposalId));
    expect(payment).toMatchObject({
      state: 'captured',
      paypalOrderId: orderId,
      paypalAuthorizationId: authId,
      paypalCaptureId: captureId,
      payeeMerchantId: ids.stride.id,
      amountCents: 5400,
    });
    const [proposal] = await conn.db
      .select({ raw: proposals.rawToolArgs })
      .from(proposals)
      .where(eq(proposals.id, body.proposalId));
    expect(proposal?.raw).toMatchObject({ payee: 'attacker@example.com', amount: 1 });
    expect(nock.pendingMocks()).toEqual([]);
    expect(noMatch).toEqual([]);
  });

  it('replays the same Idempotency-Key without a second order', async () => {
    const created: Array<{ requestId: unknown; body: unknown }> = [];
    const captured: Array<{ requestId: unknown }> = [];
    mockOAuth();
    const { authId } = mockCreate(created);
    mockCapture(authId, captured);

    const key = `idem-${randomBytes(4).toString('hex')}`;
    const responses = [];
    for (let n = 0; n < 3; n++) {
      const res = await propose(tokens.demo, { product_id: ids.cr1Stride, qty: 1 }, key);
      expect(res.statusCode).toBe(200);
      responses.push(res.json());
    }
    expect(responses[1]).toEqual(responses[0]);
    expect(responses[2]).toEqual(responses[0]);
    expect(responses[0]).toMatchObject({ decision: 'captured' });

    const [rows] = await conn.db
      .select({ n: count() })
      .from(proposals)
      .where(eq(proposals.idempotencyKey, key));
    expect(rows?.n).toBe(1);
    expect(created).toHaveLength(1);
    expect(captured).toHaveLength(1);
    expect(nock.pendingMocks()).toEqual([]);
    expect(noMatch).toEqual([]);
  });

  it('records an evaluation proposal without calling PayPal', async () => {
    const res = await propose(tokens.eval, { product_id: ids.cr1Eval, qty: 1 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ decision: 'recorded', paypalOrderCreated: false });
    expect(await paymentCount(body.proposalId)).toBe(0);
    const [decision] = await conn.db
      .select({ gate: gateDecisions.gate, outcome: gateDecisions.outcome })
      .from(gateDecisions)
      .where(eq(gateDecisions.proposalId, body.proposalId));
    expect(decision).toEqual({ gate: 'G4', outcome: 'capture' });
    expect(nock.pendingMocks()).toEqual([]);
    expect(noMatch).toEqual([]);
  });

  it('blocks on an expired rule card with an expiry hit', async () => {
    const res = await propose(tokens.expired, { product_id: ids.cr1Stride, qty: 1 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      decision: 'blocked',
      blockedBy: 'expiry',
      paypalOrderCreated: false,
      reason: 'Your spending rules have expired. No PayPal order created.',
    });
    const [decision] = await conn.db
      .select({ outcome: gateDecisions.outcome, hits: gateDecisions.ruleHits })
      .from(gateDecisions)
      .where(eq(gateDecisions.proposalId, body.proposalId));
    expect(decision?.outcome).toBe('block');
    expect(decision?.hits).toEqual([expect.objectContaining({ rule: 'expiry', passed: false })]);
    expect(await paymentCount(body.proposalId)).toBe(0);
    expect(noMatch).toEqual([]);
  });
});
