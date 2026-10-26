import { randomUUID } from 'node:crypto';
import {
  agentSessions,
  createDb,
  gateDecisions,
  listings,
  merchants,
  payments,
  proposals,
  ruleCards,
  users,
} from '@twokey/db';
import { createTestDatabase, runSeed, testDatabaseUrl } from '@twokey/db/testing';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const WEB_ORIGIN = 'http://localhost:3000';
const baseUrl = testDatabaseUrl();

type KeyLike = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

/** Reads an SSE response body and hands back frames as they arrive. */
function frames(res: Response) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  return {
    async next(match: (frame: string) => boolean, timeoutMs = 5000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let idx = buf.indexOf('\n\n');
        while (idx !== -1) {
          const f = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (match(f)) return f;
          idx = buf.indexOf('\n\n');
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new Error('timed out waiting for an SSE frame');
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timed out waiting for an SSE frame')), left),
          ),
        ]);
        if (chunk.done) throw new Error('stream ended');
        buf += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel: () => reader.cancel().catch(() => undefined),
  };
}

function dataOf(frame: string): Record<string, unknown> {
  const line = frame.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line?.slice(6) ?? '{}') as Record<string, unknown>;
}

describe.skipIf(!baseUrl)('/human/events', () => {
  let drop = async () => {};
  let app: FastifyInstance;
  let conn: ReturnType<typeof createDb>;
  let privateKey: KeyLike;
  let base = '';

  async function assertion(userId: string, scope: string[]): Promise<string> {
    const iat = Math.floor(Date.now() / 1000);
    return new SignJWT({ role: 'user', scope: scope.join(' ') })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer('twokey-web')
      .setAudience('twokey-gateway')
      .setSubject(userId)
      .setJti(randomUUID())
      .setIssuedAt(iat)
      .setExpirationTime(iat + 60)
      .sign(privateKey);
  }

  async function newUser() {
    const [row] = await conn.db
      .insert(users)
      .values({ email: `${randomUUID()}@example.test`, displayName: 'Test', role: 'user' })
      .returning({ id: users.id });
    return (row as { id: string }).id;
  }

  async function open(userId: string) {
    const res = await fetch(`${base}/human/events`, {
      headers: { authorization: `Bearer ${await assertion(userId, ['events:read'])}` },
    });
    expect(res.status).toBe(200);
    const f = frames(res);
    await f.next((x) => x === ': connected');
    return { res, f };
  }

  async function notify(payload: Record<string, unknown>) {
    await conn.db.execute(sql`select pg_notify('twokey_events', ${JSON.stringify(payload)})`);
  }

  /** A captured purchase of Cloud Runner CR-1 at Stride Supply, written straight to the tables. */
  async function capturedPurchase(userId: string) {
    const [merchant] = await conn.db
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.slug, 'stride-supply'));
    const [listing] = await conn.db
      .select({ id: listings.id, priceCents: listings.priceCents })
      .from(listings)
      .where(
        and(
          eq(listings.groupKey, 'cloud-runner-cr1'),
          eq(listings.merchantId, (merchant as { id: string }).id),
        ),
      );
    const [card] = await conn.db
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
    const [session] = await conn.db
      .insert(agentSessions)
      .values({
        userId,
        ruleCardId: (card as { id: string }).id,
        mode: 'demo',
        model: 'test',
        agentTokenHash: randomUUID(),
      })
      .returning({ id: agentSessions.id });
    const [proposal] = await conn.db
      .insert(proposals)
      .values({
        sessionId: (session as { id: string }).id,
        ruleCardId: (card as { id: string }).id,
        listingId: (listing as { id: string }).id,
        qty: 1,
        rawToolArgs: {},
        resolvedAmountCents: (listing as { priceCents: number }).priceCents,
        resolvedMerchantId: (merchant as { id: string }).id,
      })
      .returning({ id: proposals.id });
    const proposalId = (proposal as { id: string }).id;
    await conn.db
      .insert(gateDecisions)
      .values({ proposalId, gate: 'G4', outcome: 'capture', ruleHits: [], gateVersion: 'test' });
    const [payment] = await conn.db
      .insert(payments)
      .values({
        proposalId,
        payeeMerchantId: (merchant as { id: string }).id,
        amountCents: (listing as { priceCents: number }).priceCents,
        state: 'captured',
        paypalOrderId: `ORDER-${randomUUID()}`,
        paypalAuthorizationId: `AUTH-${randomUUID()}`,
        paypalCaptureId: `CAP-${randomUUID()}`,
      })
      .returning({ id: payments.id });
    return { proposalId, paymentId: (payment as { id: string }).id };
  }

  beforeAll(async () => {
    let url: string;
    ({ url, drop } = await createTestDatabase(baseUrl as string));
    await runSeed(url);
    conn = createDb(url);
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    privateKey = pair.privateKey;
    const noPayPal = async (): Promise<never> => {
      throw new Error('PayPal must not be called');
    };
    app = buildApp(
      {
        LOG_LEVEL: 'silent',
        DATABASE_URL: url,
        RULE_HMAC_KEY: Buffer.alloc(32, 1).toString('base64'),
        RULE_HMAC_KEY_ID: 'test-key',
        AGENT_TOKEN_PEPPER: 'test-pepper',
        HUMAN_ASSERTION_PUBLIC_KEY: await exportSPKI(pair.publicKey),
        WEB_ORIGIN,
      },
      {
        eventsHeartbeatMs: 200,
        paypal: {
          createVaultedAuthorization: noPayPal,
          capture: noPayPal,
          getAuthorization: noPayPal,
          getCapture: noPayPal,
        },
        vault: {
          createSetupToken: noPayPal,
          createPaymentToken: noPayPal,
          deletePaymentToken: noPayPal,
        },
      },
    );
    base = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app?.close();
    await conn?.sql.end();
    await drop();
  });

  it('rejects a missing assertion, an agent token and the wrong scope, with CORS headers', async () => {
    const userId = await newUser();
    const none = await fetch(`${base}/human/events`);
    expect(none.status).toBe(401);
    expect(none.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN);

    const agent = await fetch(`${base}/human/events`, {
      headers: { authorization: 'Bearer tk_agent_abcdefghijklmnop' },
    });
    expect(agent.status).toBe(401);

    const wrong = await fetch(`${base}/human/events`, {
      headers: { authorization: `Bearer ${await assertion(userId, ['sessions:create'])}` },
    });
    expect(wrong.status).toBe(403);
  });

  it('answers the CORS preflight for the web origin without credentials', async () => {
    const res = await fetch(`${base}/human/events`, {
      method: 'OPTIONS',
      headers: { origin: WEB_ORIGIN, 'access-control-request-headers': 'authorization' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN);
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('streams with heartbeats and delivers only the subscriber’s own events', async () => {
    const alice = await newUser();
    const bob = await newUser();
    const { res, f } = await open(alice);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');

    await f.next((x) => x === ': heartbeat');
    const entry = { turn: 1, role: 'assistant', text: 'Searching', at: new Date().toISOString() };
    await notify({ type: 'agent.step', userId: bob, sessionId: 'S-BOB', entry });
    await notify({
      type: 'agent.step',
      userId: alice,
      sessionId: 'S-ALICE',
      entry: { ...entry, usage: { inputTokens: 1 }, secret: 'x' },
    });
    const frame = await f.next((x) => x.startsWith('event: agent.step'));
    const data = dataOf(frame);
    expect(data.sessionId).toBe('S-ALICE');
    expect(data.entry).toEqual(entry);
    await f.cancel();
  });

  it('sends a payment.updated snapshot without vault fields, and lists recent proposals', async () => {
    const userId = await newUser();
    const { f } = await open(userId);
    const { proposalId, paymentId } = await capturedPurchase(userId);
    await notify({ type: 'payment.updated', userId, proposalId, paymentId, state: 'captured' });
    const frame = await f.next((x) => x.startsWith('event: payment.updated'));
    expect(frame).not.toMatch(/vault|payment_token|paymentToken/i);
    expect(dataOf(frame)).toMatchObject({
      proposalId,
      paymentId,
      state: 'captured',
      merchant: 'Stride Supply',
      buyerPresent: false,
      reason: expect.stringContaining('Bought'),
    });
    await f.cancel();

    const list = await fetch(`${base}/human/proposals?limit=10`, {
      headers: { authorization: `Bearer ${await assertion(userId, ['events:read'])}` },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: { proposalId: string }[] };
    expect(body.items.map((i) => i.proposalId)).toEqual([proposalId]);

    // Another user sees none of it.
    const other = await fetch(`${base}/human/proposals`, {
      headers: { authorization: `Bearer ${await assertion(await newUser(), ['events:read'])}` },
    });
    expect(((await other.json()) as { items: unknown[] }).items).toEqual([]);
  });
});
