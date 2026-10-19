import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PaymentState } from '@twokey/core';
import {
  agentSessions,
  createDb,
  listings,
  merchants,
  paymentEvents,
  payments,
  proposals,
  ruleCards,
  users,
  webhookEvents,
} from '@twokey/db';
import { createTestDatabase, runSeed, testDatabaseUrl } from '@twokey/db/testing';
import type { VerifyWebhookSignature } from '@twokey/paypal';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { processPendingWebhooks } from '../src/services/webhook-apply.js';

type Fixture = 'authorization-created' | 'capture-completed' | 'authorization-voided';

const FIXTURE_AUTH_ID = '0VF52814937998046';
const FIXTURE_CAPTURE_ID = '7NW873794T343360M';
const SIGNATURE_HEADERS = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42',
  'paypal-transmission-id': '69cd13f0-d67a-11e5-baa3-778b53f4ae55',
  'paypal-transmission-sig':
    'lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A9zrhdu2rMyFrmz+Zjh3s3boXB07VXCXUZy/UFzUlnGJn0wDugt7FlSvdKeIJenLRemUxYCPVoEZzg9VFNqOa48gMkvF+XTpxBeUx/kWy6B5cp7GkT2+pOowfRK7OaynuxUoKW3JcMWw272VKjLTtTAShncla7tGF+55rxyt2KNZIIqxNMJ48RDZheGU5w1npu9dZHnPgTXB9iomeVRoD8O/jhRpnKsGrDschyNdkeh81BJJMH4Ctc6lnCCquoP/GzCzz33MMsNdid7vL/NIWaCsekQpW26FpWPi/tfj8nLA==',
  'paypal-transmission-time': '2026-10-19T09:12:52Z',
};

/** A fixture event with fresh IDs, so every test works on its own payment. */
function event(name: Fixture, ids: { authId: string; captureId?: string }) {
  const text = readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')
    .replaceAll(FIXTURE_AUTH_ID, ids.authId)
    .replaceAll(FIXTURE_CAPTURE_ID, ids.captureId ?? `CAP${randomBytes(6).toString('hex')}`);
  const body = JSON.parse(text) as { id: string; event_type: string };
  body.id = `WH-${randomBytes(8).toString('hex').toUpperCase()}`;
  return body;
}

describe('POST /webhooks/paypal without PAYPAL_WEBHOOK_ID', () => {
  it('responds 503 webhook not configured', async () => {
    const verify = vi.fn<VerifyWebhookSignature>();
    const app = buildApp({ LOG_LEVEL: 'silent' }, { verifyWebhookSignature: verify });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/paypal',
      payload: { id: 'WH-test', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'X' } },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toBe('webhook not configured');
    expect(verify).not.toHaveBeenCalled();
    await app.close();
  });
});

const baseUrl = testDatabaseUrl();

describe.skipIf(!baseUrl)('POST /webhooks/paypal', () => {
  let drop = async () => {};
  let url = '';
  let app: FastifyInstance;
  let conn: ReturnType<typeof createDb>;
  let verify: VerifyWebhookSignature;
  const ctx = { userId: '', sessionId: '', ruleCardId: '', listingId: '', merchantId: '' };

  beforeAll(async () => {
    ({ url, drop } = await createTestDatabase(baseUrl as string));
    await runSeed(url);
    conn = createDb(url);
    const { db } = conn;

    const [listing] = await db
      .select({ id: listings.id, merchantId: listings.merchantId })
      .from(listings)
      .innerJoin(merchants, eq(merchants.id, listings.merchantId))
      .where(eq(merchants.slug, 'stride-supply'))
      .limit(1);
    if (!listing) throw new Error('seed has no Stride Supply listing');
    const [user] = await db
      .insert(users)
      .values({ email: 'webhooks@example.test', displayName: 'Webhooks' })
      .returning({ id: users.id });
    const userId = (user as { id: string }).id;
    const [card] = await db
      .insert(ruleCards)
      .values({
        userId,
        version: 1,
        status: 'draft',
        nlRequest: 'test',
        rules: {},
        enforcement: {},
      })
      .returning({ id: ruleCards.id });
    const ruleCardId = (card as { id: string }).id;
    const [session] = await db
      .insert(agentSessions)
      .values({
        userId,
        ruleCardId,
        mode: 'demo',
        model: 'test',
        agentTokenHash: randomBytes(16).toString('hex'),
      })
      .returning({ id: agentSessions.id });
    Object.assign(ctx, {
      userId,
      ruleCardId,
      sessionId: (session as { id: string }).id,
      listingId: listing.id,
      merchantId: listing.merchantId,
    });

    app = buildApp(
      { LOG_LEVEL: 'silent', DATABASE_URL: url, PAYPAL_WEBHOOK_ID: 'WH-ID-TEST' },
      { verifyWebhookSignature: (i) => verify(i) },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await conn?.sql.end();
    await drop();
  });

  beforeEach(() => {
    verify = vi.fn<VerifyWebhookSignature>().mockResolvedValue('SUCCESS');
  });

  async function newPayment(state: PaymentState, authId = `AUTH${randomBytes(6).toString('hex')}`) {
    const [proposal] = await conn.db
      .insert(proposals)
      .values({
        sessionId: ctx.sessionId,
        ruleCardId: ctx.ruleCardId,
        listingId: ctx.listingId,
        qty: 1,
        rawToolArgs: {},
        resolvedAmountCents: 5400,
        resolvedMerchantId: ctx.merchantId,
      })
      .returning({ id: proposals.id });
    const [payment] = await conn.db
      .insert(payments)
      .values({
        proposalId: (proposal as { id: string }).id,
        paypalAuthorizationId: authId,
        payeeMerchantId: ctx.merchantId,
        amountCents: 5400,
        state,
      })
      .returning({ id: payments.id });
    return { paymentId: (payment as { id: string }).id, authId };
  }

  const post = (payload: unknown, headers: Record<string, string> = SIGNATURE_HEADERS) =>
    app.inject({ method: 'POST', url: '/webhooks/paypal', headers, payload: payload as object });

  async function paymentRow(id: string) {
    const [row] = await conn.db.select().from(payments).where(eq(payments.id, id));
    return row;
  }
  const eventsFor = (paymentId: string) =>
    conn.db.select().from(paymentEvents).where(eq(paymentEvents.paymentId, paymentId));
  const webhookRows = (eventId: string) =>
    conn.db.select().from(webhookEvents).where(eq(webhookEvents.paypalEventId, eventId));

  it('(a) a capture that arrives before AUTHORIZATION.CREATED ends captured', async () => {
    const { paymentId, authId } = await newPayment('authorizing');
    const captureId = `CAP${randomBytes(6).toString('hex')}`;

    const capture = await post(event('capture-completed', { authId, captureId }));
    expect(capture.statusCode).toBe(200);
    expect(capture.json()).toEqual({ result: 'applied' });

    const created = await post(event('authorization-created', { authId }));
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({ result: 'stale' });

    const payment = await paymentRow(paymentId);
    expect(payment?.state).toBe('captured');
    expect(payment?.paypalCaptureId).toBe(captureId);
    const events = await eventsFor(paymentId);
    expect(events.map((e) => [e.type, e.fromState, e.toState]).sort()).toEqual([
      ['PAYMENT.CAPTURE.COMPLETED', 'authorizing', 'captured'],
      ['ignored_stale', 'captured', 'captured'],
    ]);
  });

  it('(b) the same event posted twice is stored once and reported as a duplicate', async () => {
    const { paymentId, authId } = await newPayment('authorized');
    const body = event('capture-completed', { authId });

    const first = await post(body);
    const second = await post(body);
    expect(first.json()).toEqual({ result: 'applied' });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ duplicate: true });
    expect(await webhookRows(body.id)).toHaveLength(1);
    expect(await eventsFor(paymentId)).toHaveLength(1);
  });

  it('(c) a FAILURE verification answers 400 and leaves the payment unchanged', async () => {
    const { paymentId, authId } = await newPayment('authorized');
    verify = vi.fn<VerifyWebhookSignature>().mockResolvedValue('FAILURE');
    const body = event('capture-completed', { authId });

    const res = await post(body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('WEBHOOK_UNVERIFIED');
    expect((await paymentRow(paymentId))?.state).toBe('authorized');
    expect(await eventsFor(paymentId)).toHaveLength(0);
    const [row] = await webhookRows(body.id);
    expect(row).toMatchObject({ verification: 'FAILURE', processedAt: null });
  });

  it('(c2) a verified delivery still applies after a forged event claimed its ID', async () => {
    const { paymentId, authId } = await newPayment('authorized');
    const body = event('capture-completed', { authId });

    verify = vi.fn<VerifyWebhookSignature>().mockResolvedValue('FAILURE');
    expect((await post(body)).statusCode).toBe(400);
    verify = vi.fn<VerifyWebhookSignature>().mockResolvedValue('SUCCESS');
    const res = await post(body);
    expect(res.json()).toEqual({ result: 'applied' });
    expect((await paymentRow(paymentId))?.state).toBe('captured');
    expect(await webhookRows(body.id)).toMatchObject([{ verification: 'SUCCESS' }]);
  });

  it('(d) a verification outage answers 503 and stores nothing', async () => {
    const { paymentId, authId } = await newPayment('authorized');
    verify = vi.fn<VerifyWebhookSignature>().mockRejectedValue(new Error('ECONNRESET'));
    const body = event('capture-completed', { authId });

    const res = await post(body);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('UPSTREAM_PAYPAL');
    expect(await webhookRows(body.id)).toHaveLength(0);
    expect((await paymentRow(paymentId))?.state).toBe('authorized');
  });

  it('(e) an event for an unknown authorization waits, then applies once the payment exists', async () => {
    const authId = `AUTH${randomBytes(6).toString('hex')}`;
    const body = event('authorization-voided', { authId });

    const res = await post(body);
    expect(res.json()).toEqual({ result: 'no_payment' });
    expect(await webhookRows(body.id)).toMatchObject([{ processedAt: null, attempts: 1 }]);

    const { paymentId } = await newPayment('authorized', authId);
    const counts = await processPendingWebhooks(conn.db, app.log);
    expect(counts.applied).toBeGreaterThanOrEqual(1);
    expect((await paymentRow(paymentId))?.state).toBe('voided');
    const [row] = await webhookRows(body.id);
    expect(row?.processedAt).toBeInstanceOf(Date);
  });

  it('(f) a LISTEN client receives the payment.updated notification', async () => {
    const { paymentId, authId } = await newPayment('authorized');
    const received = new Promise<unknown>((resolve) => {
      void conn.sql.listen('twokey_events', (payload) => {
        const msg = JSON.parse(payload) as { paymentId?: string };
        if (msg.paymentId === paymentId) resolve(msg);
      });
    });
    // listen() resolves once LISTEN has run; give it a moment before the event fires.
    await new Promise((r) => setTimeout(r, 100));

    const res = await post(event('capture-completed', { authId }));
    expect(res.json()).toEqual({ result: 'applied' });
    await expect(received).resolves.toEqual({
      type: 'payment.updated',
      userId: ctx.userId,
      paymentId,
      state: 'captured',
    });
  });

  it('rejects a body without event_type as VALIDATION before verifying', async () => {
    const res = await post({ id: 'WH-NO-TYPE', resource: { id: 'X' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
    expect(verify).not.toHaveBeenCalled();
  });

  it('passes the paypal-* headers, the event and the webhook ID to the verifier', async () => {
    const { authId } = await newPayment('authorized');
    const body = event('authorization-voided', { authId });
    await post(body);
    expect(verify).toHaveBeenCalledWith({
      headers: expect.objectContaining(SIGNATURE_HEADERS),
      event: body,
      webhookId: 'WH-ID-TEST',
    });
  });
});
