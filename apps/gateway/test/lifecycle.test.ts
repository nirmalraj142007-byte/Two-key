import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createLogger, type RuleCard, signCard } from '@twokey/core';
import {
  agentSessions,
  approvals,
  createDb,
  listings,
  merchants,
  paymentEvents,
  payments,
  ruleCards,
  users,
  vaultTokens,
  webhookEvents,
} from '@twokey/db';
import { createTestDatabase, runSeed, testDatabaseUrl } from '@twokey/db/testing';
import { createPayPal, type PayPal } from '@twokey/paypal';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { mintAgentToken } from '../src/auth/agent-token.js';
import { handleHoldTimeout } from '../src/jobs/hold-timeout.js';
import type { JobDeps, Jobs, QueueName, SendOptions } from '../src/jobs/queue.js';
import { reconcilePayment } from '../src/jobs/reconcile.js';
import { runSweep } from '../src/jobs/sweep.js';
import { ALREADY_DECIDED, HOLD_VOIDED } from '../src/services/settle.js';
import { applyWebhookEvent } from '../src/services/webhook-apply.js';

const PAYPAL = 'https://api-m.sandbox.paypal.com';
const PEPPER = 'test-pepper';
const KEY = { id: 'test-key', secret: randomBytes(32) };
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const baseUrl = testDatabaseUrl();

describe.skipIf(!baseUrl)('hold lifecycle', () => {
  let drop = async () => {};
  let app: FastifyInstance;
  let conn: ReturnType<typeof createDb>;
  let paypal: PayPal;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let noMatch: string[] = [];
  const onNoMatch = (req: { method?: string; path?: string }) => {
    noMatch.push(`${req.method} ${req.path}`);
  };
  const sent: Array<{ name: QueueName; data: Record<string, unknown>; opts?: SendOptions }> = [];
  const jobs: Jobs = {
    async send(name, data, opts) {
      sent.push({ name, data, ...(opts ? { opts } : {}) });
    },
  };
  const ids = { tr2: '', allowed: [] as string[] };
  /** A fresh user per test, so pending lists and stats are exact. */
  let user = { id: '', token: '' };

  const deps = (): JobDeps => app.jobDeps as JobDeps;

  async function assertion(userId: string, scope = 'approvals:decide'): Promise<string> {
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

  async function human(method: 'GET' | 'POST', url: string, payload?: object, userId = user.id) {
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${await assertion(userId)}` },
      ...(payload ? { payload: payload as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  }

  async function newUser() {
    const [row] = await conn.db
      .insert(users)
      .values({ email: `${randomUUID()}@example.test`, displayName: 'Lifecycle' })
      .returning({ id: users.id });
    const userId = (row as { id: string }).id;
    await conn.db.insert(vaultTokens).values({
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
      allowedMerchantIds: ids.allowed,
      maxQtyPerOrder: 1,
      frequency: { maxPurchases: 50, windowHours: 24 },
      holdTimeoutMinutes: 15,
      anomaly: { priceRatioThreshold: 1.3 },
      expiresAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
      advisory: [],
    };
    const signed = signCard(card, KEY);
    const [cardRow] = await conn.db
      .insert(ruleCards)
      .values({
        userId,
        version: 1,
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
      mode: 'demo',
      model: 'test',
      agentTokenHash: hash,
    });
    return { id: userId, token };
  }

  function mockOAuth() {
    nock(PAYPAL)
      .post('/v1/oauth2/token')
      .once()
      .reply(200, { access_token: 'A21-test', token_type: 'Bearer', expires_in: 32400 });
  }

  /** TR-2 at Peak Outfitters ($64.40 vs a $46.00 median): authorized, then held. */
  async function hold() {
    mockOAuth();
    const authId = `AUTH${randomBytes(6).toString('hex').toUpperCase()}`;
    nock(PAYPAL)
      .post('/v2/checkout/orders')
      .once()
      .reply(201, {
        id: `ORDER${randomBytes(6).toString('hex').toUpperCase()}`,
        status: 'COMPLETED',
        purchase_units: [{ payments: { authorizations: [{ id: authId, status: 'CREATED' }] } }],
      });
    const res = await app.inject({
      method: 'POST',
      url: '/agent/proposals',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { product_id: ids.tr2, qty: 1 },
    });
    expect(res.json()).toMatchObject({ decision: 'held', paymentState: 'held' });
    const { proposalId } = res.json() as { proposalId: string };
    const [row] = await conn.db
      .select({
        paymentId: payments.id,
        approvalId: approvals.id,
        deadlineAt: approvals.deadlineAt,
      })
      .from(payments)
      .innerJoin(approvals, eq(approvals.paymentId, payments.id))
      .where(eq(payments.proposalId, proposalId));
    if (!row) throw new Error('held payment has no approval');
    return { proposalId, authId, ...row };
  }

  /** Records each request's PayPal-Request-Id; `reply` is [status, body]. */
  function mockPost(
    path: string,
    seen: unknown[],
    reply: [number, unknown?],
    opts: { times?: number; delayMs?: number } = {},
  ) {
    nock(PAYPAL)
      .post(path)
      .times(opts.times ?? 1)
      .delay(opts.delayMs ?? 0)
      .reply(function () {
        seen.push(this.req.headers['paypal-request-id']);
        return reply;
      });
  }

  async function state(paymentId: string) {
    const [row] = await conn.db
      .select({ state: payments.state, captureId: payments.paypalCaptureId })
      .from(payments)
      .where(eq(payments.id, paymentId));
    return row;
  }

  async function approvalOf(paymentId: string) {
    const [row] = await conn.db
      .select({ status: approvals.status, via: approvals.decidedVia, at: approvals.decidedAt })
      .from(approvals)
      .where(eq(approvals.paymentId, paymentId));
    return row;
  }

  function eventsOf(paymentId: string) {
    return conn.db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.paymentId, paymentId))
      .orderBy(asc(paymentEvents.receivedAt));
  }

  async function backdateDeadline(paymentId: string) {
    const past = new Date(Date.now() - MINUTE_MS);
    await conn.db
      .update(approvals)
      .set({ deadlineAt: past })
      .where(eq(approvals.paymentId, paymentId));
    await conn.db.update(payments).set({ holdDeadlineAt: past }).where(eq(payments.id, paymentId));
  }

  beforeAll(async () => {
    let url: string;
    ({ url, drop } = await createTestDatabase(baseUrl as string));
    await runSeed(url);
    conn = createDb(url);

    const all = await conn.db.select().from(merchants);
    const bySlug = (slug: string) => {
      const m = all.find((x) => x.slug === slug);
      if (!m) throw new Error(`seed has no merchant ${slug}`);
      return m;
    };
    ids.allowed = ['stride-supply', 'peak-outfitters', 'pacer-goods'].map((s) => bySlug(s).id);
    const [tr2] = await conn.db
      .select({ id: listings.id })
      .from(listings)
      .where(
        and(
          eq(listings.groupKey, 'trail-runner-tr2'),
          eq(listings.merchantId, bySlug('peak-outfitters').id),
        ),
      );
    ids.tr2 = (tr2 as { id: string }).id;

    const pair = await generateKeyPair('EdDSA');
    privateKey = pair.privateKey;
    const noPayPal = async (): Promise<never> => {
      throw new Error('not used');
    };
    app = buildApp(
      {
        LOG_LEVEL: 'silent',
        DATABASE_URL: url,
        RULE_HMAC_KEY: KEY.secret.toString('base64'),
        RULE_HMAC_KEY_ID: KEY.id,
        AGENT_TOKEN_PEPPER: PEPPER,
        HUMAN_ASSERTION_PUBLIC_KEY: await exportSPKI(pair.publicKey),
        WEB_ORIGIN: 'http://localhost:3000',
      },
      {
        // A fresh client per test, so each test sees its own OAuth call.
        paypal: {
          createVaultedAuthorization: (i) => paypal.createVaultedAuthorization(i),
          capture: (i) => paypal.capture(i),
          voidAuthorization: (i) => paypal.voidAuthorization(i),
          getAuthorization: (id) => paypal.getAuthorization(id),
          getCapture: (id) => paypal.getCapture(id),
        },
        vault: {
          createSetupToken: noPayPal,
          createPaymentToken: noPayPal,
          deletePaymentToken: noPayPal,
        },
        jobs,
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

  beforeEach(async () => {
    noMatch = [];
    sent.length = 0;
    paypal = createPayPal({
      clientId: 'test-client',
      clientSecret: 'test-secret',
      env: 'sandbox',
      logger: createLogger('gateway', 'silent'),
    });
    user = await newUser();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('(1) approve: one capture with tk-<id>-capture, captured, approval approved via web', async () => {
    const h = await hold();
    // The hold's timer was queued for its deadline, one per payment.
    expect(sent).toContainEqual({
      name: 'hold.timeout',
      data: { paymentId: h.paymentId },
      opts: { startAfter: h.deadlineAt, singletonKey: h.paymentId },
    });

    const list = await human('GET', '/human/approvals?status=pending');
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([
      expect.objectContaining({
        id: h.approvalId,
        paymentId: h.paymentId,
        merchant: 'Peak Outfitters',
        amount: '$64.40',
        referencePrice: '$46.00',
        ratio: 1.4,
        deadlineAt: h.deadlineAt.toISOString(),
      }),
    ]);
    expect(await human('GET', '/human/stats')).toEqual({
      status: 200,
      body: { openAuthorizations: 1 },
    });

    const seen: unknown[] = [];
    mockPost(`/v2/payments/authorizations/${h.authId}/capture`, seen, [
      201,
      { id: 'CAP-1', status: 'COMPLETED' },
    ]);
    const res = await human('POST', `/human/approvals/${h.approvalId}`, {
      decision: 'approve',
      via: 'web',
    });
    expect(res).toEqual({ status: 200, body: { state: 'captured' } });
    expect(seen).toEqual([`tk-${h.proposalId}-capture`]);
    expect(await state(h.paymentId)).toEqual({ state: 'captured', captureId: 'CAP-1' });
    expect(await approvalOf(h.paymentId)).toMatchObject({ status: 'approved', via: 'web' });
    expect(sent).toContainEqual({
      name: 'payment.reconcile',
      data: { paymentId: h.paymentId },
      opts: { startAfter: 30, singletonKey: h.paymentId },
    });
    expect(await human('GET', '/human/stats')).toEqual({
      status: 200,
      body: { openAuthorizations: 0 },
    });
    expect((await human('GET', '/human/approvals')).body.items).toEqual([]);
    expect(noMatch).toEqual([]);
  });

  it('(2) deny: one void, voided, approval denied; another user gets 404', async () => {
    const h = await hold();
    const other = await newUser();
    const foreign = await human(
      'POST',
      `/human/approvals/${h.approvalId}`,
      { decision: 'deny', via: 'web' },
      other.id,
    );
    expect(foreign.status).toBe(404);

    const seen: unknown[] = [];
    mockPost(`/v2/payments/authorizations/${h.authId}/void`, seen, [204]);
    const res = await human('POST', `/human/approvals/${h.approvalId}`, {
      decision: 'deny',
      via: 'phone',
    });
    expect(res).toEqual({ status: 200, body: { state: 'voided' } });
    expect(seen).toEqual([`tk-${h.proposalId}-void`]);
    expect((await state(h.paymentId))?.state).toBe('voided');
    expect(await approvalOf(h.paymentId)).toMatchObject({ status: 'denied', via: 'phone' });
    expect(noMatch).toEqual([]);
  });

  it('(3) timeout job: voided, approval timed_out; running it again is a no-op', async () => {
    const h = await hold();
    const seen: unknown[] = [];
    mockPost(`/v2/payments/authorizations/${h.authId}/void`, seen, [204]);
    expect(await handleHoldTimeout(deps(), { paymentId: h.paymentId })).toBe('voided');
    expect(seen).toEqual([`tk-${h.proposalId}-void`]);
    expect((await state(h.paymentId))?.state).toBe('voided');
    expect(await approvalOf(h.paymentId)).toMatchObject({ status: 'timed_out', via: null });
    const timerEvent = (await eventsOf(h.paymentId)).find((e) => e.type === 'void.requested');
    expect(timerEvent).toMatchObject({ source: 'timer', fromState: 'held' });

    // A redelivered job finds nothing to do and calls PayPal zero times.
    expect(await handleHoldTimeout(deps(), { paymentId: h.paymentId })).toBeNull();
    expect(seen).toHaveLength(1);
    expect(noMatch).toEqual([]);
  });

  it('(4) approve after the deadline: 409 and zero PayPal calls', async () => {
    const h = await hold();
    await backdateDeadline(h.paymentId);
    const res = await human('POST', `/human/approvals/${h.approvalId}`, {
      decision: 'approve',
      via: 'web',
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'CONFLICT', message: HOLD_VOIDED } });
    expect(noMatch).toEqual([]); // net connect is disabled: any PayPal call would land here
    expect((await state(h.paymentId))?.state).toBe('held');

    // The timer then voids it (timer voids ignore the deadline).
    const seen: unknown[] = [];
    mockPost(`/v2/payments/authorizations/${h.authId}/void`, seen, [204]);
    expect(await handleHoldTimeout(deps(), { paymentId: h.paymentId })).toBe('voided');
    expect(seen).toHaveLength(1);
  });

  it('(5) two concurrent approves: exactly one capture, one 200 and one 409', async () => {
    const h = await hold();
    const seen: unknown[] = [];
    mockPost(
      `/v2/payments/authorizations/${h.authId}/capture`,
      seen,
      [201, { id: 'CAP-5', status: 'COMPLETED' }],
      { times: 2, delayMs: 150 },
    );
    const body = { decision: 'approve', via: 'web' };
    const results = await Promise.all([
      human('POST', `/human/approvals/${h.approvalId}`, body),
      human('POST', `/human/approvals/${h.approvalId}`, body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body).toMatchObject({
      error: { code: 'CONFLICT', message: ALREADY_DECIDED },
    });
    expect(seen).toEqual([`tk-${h.proposalId}-capture`]);
    expect((await state(h.paymentId))?.state).toBe('captured');
  });

  it('(6) capture 422 AUTHORIZATION_EXPIRED: expired, timed_out, never captured again', async () => {
    const h = await hold();
    const seen: unknown[] = [];
    mockPost(`/v2/payments/authorizations/${h.authId}/capture`, seen, [
      422,
      fixture('capture-authorization-expired.json'),
    ]);
    const res = await human('POST', `/human/approvals/${h.approvalId}`, {
      decision: 'approve',
      via: 'web',
    });
    expect(res).toEqual({ status: 200, body: { state: 'expired' } });
    expect(await approvalOf(h.paymentId)).toMatchObject({ status: 'timed_out', via: 'web' });
    const expired = (await eventsOf(h.paymentId)).find(
      (e) => e.type === 'capture.authorization_expired',
    );
    expect(expired).toMatchObject({ fromState: 'capture_requested', toState: 'expired' });
    expect(expired?.payload).toMatchObject({
      issue: 'AUTHORIZATION_EXPIRED',
      details: { httpStatus: 422, issues: ['AUTHORIZATION_EXPIRED'], debug_id: 'f1e2d3c4b5a69' },
    });

    // No retry: a second approve is refused before PayPal, and the reconciler skips it.
    const again = await human('POST', `/human/approvals/${h.approvalId}`, {
      decision: 'approve',
      via: 'web',
    });
    expect(again.status).toBe(409);
    expect(await reconcilePayment(deps(), h.paymentId)).toBe('skipped');
    expect(seen).toHaveLength(1);
    expect(noMatch).toEqual([]);
  });

  it('(7) CAPTURE.COMPLETED arriving 10 minutes late stays captured, recorded ignored_stale', async () => {
    const h = await hold();
    mockPost(
      `/v2/payments/authorizations/${h.authId}/capture`,
      [],
      [201, { id: 'CAP-7', status: 'COMPLETED' }],
    );
    await human('POST', `/human/approvals/${h.approvalId}`, { decision: 'approve', via: 'web' });
    expect((await state(h.paymentId))?.state).toBe('captured');

    const event = fixture('capture-completed.json');
    event.id = `WH-${randomUUID()}`;
    event.resource.id = 'CAP-7';
    event.resource.supplementary_data.related_ids.authorization_id = h.authId;
    const [row] = await conn.db
      .insert(webhookEvents)
      .values({
        paypalEventId: event.id,
        eventType: event.event_type,
        resourceId: 'CAP-7',
        verification: 'SUCCESS',
        raw: event,
        receivedAt: new Date(Date.now() + 10 * MINUTE_MS),
      })
      .returning();
    expect(await applyWebhookEvent(conn.db, row as typeof webhookEvents.$inferSelect)).toBe(
      'stale',
    );
    expect((await state(h.paymentId))?.state).toBe('captured');
    const stale = (await eventsOf(h.paymentId)).filter((e) => e.type === 'ignored_stale');
    expect(stale).toEqual([
      expect.objectContaining({
        source: 'webhook',
        paypalEventId: event.id,
        fromState: 'captured',
        toState: 'captured',
      }),
    ]);
  });

  it('(8) webhook missing: the reconcile job settles from GET authorization', async () => {
    const h = await hold();
    const seen: unknown[] = [];
    mockPost(`/v2/payments/authorizations/${h.authId}/capture`, seen, [
      503,
      { name: 'SERVICE_UNAVAILABLE', message: 'Service Unavailable.', debug_id: 'dbg503' },
    ]);
    const res = await human('POST', `/human/approvals/${h.approvalId}`, {
      decision: 'approve',
      via: 'web',
    });
    // Retryable: PayPal may have captured, so we wait for PayPal's truth instead of failing.
    expect(res).toEqual({ status: 200, body: { state: 'capture_requested' } });
    expect(await approvalOf(h.paymentId)).toMatchObject({ status: 'approved' });
    expect(sent.filter((s) => s.name === 'payment.reconcile')).toHaveLength(1);

    nock(PAYPAL)
      .get(`/v2/payments/authorizations/${h.authId}`)
      .once()
      .reply(200, { id: h.authId, status: 'CAPTURED' });
    expect(await reconcilePayment(deps(), h.paymentId)).toBe('changed');
    expect((await state(h.paymentId))?.state).toBe('captured');
    const reconciled = (await eventsOf(h.paymentId)).filter((e) => e.source === 'reconciler');
    expect(reconciled).toEqual([
      expect.objectContaining({
        fromState: 'capture_requested',
        toState: 'captured',
        payload: { authorizationStatus: 'CAPTURED' },
      }),
    ]);
    // Settled: a second run reads nothing and records nothing.
    expect(await reconcilePayment(deps(), h.paymentId)).toBe('skipped');
    expect(seen).toHaveLength(1);
    expect(noMatch).toEqual([]);
  });

  it('(9) sweep voids an overdue held payment', async () => {
    const h = await hold();
    await backdateDeadline(h.paymentId);
    const seen: unknown[] = [];
    mockPost(`/v2/payments/authorizations/${h.authId}/void`, seen, [204]);
    const result = await runSweep(deps());
    expect(result).toEqual({ voided: 1, reconciled: 0, openAuthorizations: 0 });
    expect(seen).toEqual([`tk-${h.proposalId}-void`]);
    expect((await state(h.paymentId))?.state).toBe('voided');
    expect(await approvalOf(h.paymentId)).toMatchObject({ status: 'timed_out' });
    expect(noMatch).toEqual([]);
  });
});
