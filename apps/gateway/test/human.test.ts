import { randomBytes, randomUUID } from 'node:crypto';
import { verifyCard } from '@twokey/core';
import {
  agentSessions,
  createDb,
  listings,
  merchants,
  ruleCards,
  users,
  vaultTokens,
} from '@twokey/db';
import { createTestDatabase, runSeed, testDatabaseUrl } from '@twokey/db/testing';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { exportSPKI, generateKeyPair, type JWTPayload, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { mintAgentToken } from '../src/auth/agent-token.js';

const PEPPER = 'test-pepper';
const KEY = { id: 'test-key', secret: randomBytes(32) };
const WEB_ORIGIN = 'http://localhost:3000';
const DAY_MS = 24 * 60 * 60 * 1000;

type Role = 'user' | 'judge_demo' | 'hijack_system';
type KeyLike = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

const baseUrl = testDatabaseUrl();

describe.skipIf(!baseUrl)('/human/*', () => {
  let drop = async () => {};
  let app: FastifyInstance;
  let conn: ReturnType<typeof createDb>;
  let privateKey: KeyLike;
  let otherKey: KeyLike;
  let merchantIds: string[] = [];
  let productId = '';
  const vaultCalls: string[] = [];
  let setupCounter = 0;

  /** Mirrors apps/web/lib/human-assertion.ts; `over` lets a test break one claim at a time. */
  async function assertion(
    userId: string,
    role: Role,
    scope: string[],
    over: { iss?: string; aud?: string; iat?: number; exp?: number; key?: KeyLike } = {},
  ): Promise<string> {
    const iat = over.iat ?? Math.floor(Date.now() / 1000);
    return new SignJWT({ role, scope: scope.join(' ') } satisfies JWTPayload)
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer(over.iss ?? 'twokey-web')
      .setAudience(over.aud ?? 'twokey-gateway')
      .setSubject(userId)
      .setJti(randomUUID())
      .setIssuedAt(iat)
      .setExpirationTime(over.exp ?? iat + 60)
      .sign(over.key ?? privateKey);
  }

  async function call(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    bearer: string | undefined,
    payload?: unknown,
  ) {
    const res = await app.inject({
      method,
      url,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  }

  async function as(
    who: { id: string; role: Role },
    scope: string[],
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: unknown,
  ) {
    return call(method, url, await assertion(who.id, who.role, scope), payload);
  }

  async function newUser(role: Role = 'user') {
    const [row] = await conn.db
      .insert(users)
      .values({ email: `${randomUUID()}@example.test`, displayName: 'Test', role })
      .returning({ id: users.id });
    return { id: (row as { id: string }).id, role };
  }

  async function connectVault(userId: string) {
    await conn.db.insert(vaultTokens).values({
      userId,
      paypalCustomerId: 'CUST-TEST',
      paymentTokenId: `VAULT-${randomBytes(6).toString('hex')}`,
      status: 'active',
    });
  }

  function draftRules(over: Record<string, unknown> = {}) {
    return {
      currency: 'USD',
      perItemCapCents: 7000,
      perOrderCapCents: 7000,
      allowedMerchantIds: merchantIds,
      maxQtyPerOrder: 1,
      frequency: { maxPurchases: 50, windowHours: 24 },
      holdTimeoutMinutes: 15,
      anomaly: { priceRatioThreshold: 1.3 },
      expiresAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
      advisory: [{ key: 'size', value: '10', label: 'Size' }],
      ...over,
    };
  }

  async function newDraft(userId: string, rules: Record<string, unknown> = draftRules()) {
    const [row] = await conn.db
      .insert(ruleCards)
      .values({
        userId,
        version: 1000 + Math.floor(Math.random() * 1e6),
        status: 'draft',
        nlRequest: 'test',
        rules,
        enforcement: {},
      })
      .returning({ id: ruleCards.id });
    return (row as { id: string }).id;
  }

  async function signDraft(user: { id: string; role: Role }) {
    const id = await newDraft(user.id);
    const res = await as(user, ['rules:sign'], 'POST', `/human/rules/${id}/sign`);
    expect(res.status).toBe(200);
    return id;
  }

  async function propose(token: string) {
    return call('POST', '/agent/proposals', token, { product_id: productId, qty: 1 });
  }

  beforeAll(async () => {
    let url: string;
    ({ url, drop } = await createTestDatabase(baseUrl as string));
    await runSeed(url);
    conn = createDb(url);

    const pair = await generateKeyPair('EdDSA', { extractable: true });
    privateKey = pair.privateKey;
    otherKey = (await generateKeyPair('EdDSA')).privateKey;

    const all = await conn.db.select().from(merchants);
    merchantIds = all
      .filter((m) => ['stride-supply', 'peak-outfitters', 'pacer-goods'].includes(m.slug))
      .map((m) => m.id);
    const [listing] = await conn.db
      .select({ id: listings.id })
      .from(listings)
      .innerJoin(merchants, eq(merchants.id, listings.merchantId))
      .where(and(eq(listings.groupKey, 'cloud-runner-cr1'), eq(merchants.slug, 'stride-supply')));
    productId = (listing as { id: string }).id;

    const noPayPal = async (): Promise<never> => {
      throw new Error('PayPal must not be called');
    };
    app = buildApp(
      {
        LOG_LEVEL: 'silent',
        DATABASE_URL: url,
        RULE_HMAC_KEY: KEY.secret.toString('base64'),
        RULE_HMAC_KEY_ID: KEY.id,
        AGENT_TOKEN_PEPPER: PEPPER,
        HUMAN_ASSERTION_PUBLIC_KEY: await exportSPKI(pair.publicKey),
        WEB_ORIGIN,
      },
      {
        paypal: {
          createVaultedAuthorization: noPayPal,
          capture: noPayPal,
          voidAuthorization: noPayPal,
          getAuthorization: noPayPal,
          getCapture: noPayPal,
        },
        vault: {
          async createSetupToken() {
            vaultCalls.push('createSetupToken');
            const id = `SETUP-${++setupCounter}`;
            return { id, status: 'PAYER_ACTION_REQUIRED', approveUrl: `https://pp.test/${id}` };
          },
          async createPaymentToken({ setupTokenId }) {
            vaultCalls.push(`createPaymentToken ${setupTokenId}`);
            return { paymentTokenId: `PT-${setupTokenId}`, customerId: 'CUST-1' };
          },
          async deletePaymentToken(id) {
            vaultCalls.push(`deletePaymentToken ${id}`);
          },
        },
      },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await conn?.sql.end();
    await drop();
  });

  beforeEach(() => {
    vaultCalls.length = 0;
  });

  // ---- assertion checks --------------------------------------------------------------------

  describe('assertion checks', () => {
    it('rejects a missing Authorization header with 401', async () => {
      const res = await call('GET', '/human/me', undefined);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    });

    it('rejects a valid agent token with 401', async () => {
      const user = await newUser();
      await connectVault(user.id);
      await signDraft(user);
      const created = await as(user, ['sessions:create'], 'POST', '/human/sessions', {
        mode: 'demo',
        model: 'test',
      });
      const token = created.body.token as string;
      expect(token.startsWith('tk_agent_')).toBe(true);
      for (const [method, url] of [
        ['GET', '/human/me'],
        ['POST', '/human/sessions'],
        ['DELETE', '/human/vault'],
      ] as const) {
        const res = await call(method, url, token, method === 'POST' ? {} : undefined);
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
      }
    });

    it('rejects the wrong issuer, audience, key, an expired token or a long lifetime', async () => {
      const user = await newUser();
      const past = Math.floor(Date.now() / 1000) - 120;
      const bad = [
        await assertion(user.id, 'user', [], { iss: 'someone-else' }),
        await assertion(user.id, 'user', [], { aud: 'twokey-mcp' }),
        await assertion(user.id, 'user', [], { key: otherKey }),
        await assertion(user.id, 'user', [], { iat: past, exp: past + 60 }),
        await assertion(user.id, 'user', [], { exp: Math.floor(Date.now() / 1000) + 3600 }),
        'not-a-jwt',
      ];
      for (const token of bad) {
        const res = await call('GET', '/human/me', token);
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
      }
    });

    it('rejects a missing scope with 403', async () => {
      const user = await newUser();
      const id = await newDraft(user.id);
      const res = await as(user, ['vault:manage'], 'POST', `/human/rules/${id}/sign`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    });

    it('rejects a replayed jti with 401', async () => {
      const user = await newUser();
      const token = await assertion(user.id, 'user', []);
      expect((await call('GET', '/human/me', token)).status).toBe(200);
      const again = await call('GET', '/human/me', token);
      expect(again.status).toBe(401);
      expect(again.body).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    });
  });

  // ---- me ----------------------------------------------------------------------------------

  it('GET /human/me reports the asserted user, vault and active card', async () => {
    const user = await newUser();
    let res = await as(user, [], 'GET', '/human/me');
    expect(res.body).toEqual({
      userId: user.id,
      role: 'user',
      vaultConnected: false,
      activeCardId: null,
    });
    await connectVault(user.id);
    const cardId = await signDraft(user);
    res = await as(user, [], 'GET', '/human/me');
    expect(res.body).toEqual({
      userId: user.id,
      role: 'user',
      vaultConnected: true,
      activeCardId: cardId,
    });
  });

  // ---- vault -------------------------------------------------------------------------------

  describe('vault', () => {
    it('setup-token requires a returnUrl on the web origin', async () => {
      const user = await newUser();
      for (const returnUrl of ['https://evil.test/x', 'http://localhost:3000.evil.test/x', 'x']) {
        const res = await as(user, ['vault:manage'], 'POST', '/human/vault/setup-token', {
          returnUrl,
        });
        expect(res.status).toBe(400);
      }
      expect(vaultCalls).toEqual([]);
      const res = await as(user, ['vault:manage'], 'POST', '/human/vault/setup-token', {
        returnUrl: `${WEB_ORIGIN}/onboarding/paypal/return`,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        setupTokenId: expect.any(String),
        approveUrl: expect.any(String),
      });
    });

    it("payment-token accepts only this user's latest setup token and replaces the old wallet", async () => {
      const user = await newUser();
      const other = await newUser();
      await connectVault(user.id);
      const setup = async (who: typeof user) =>
        (
          await as(who, ['vault:manage'], 'POST', '/human/vault/setup-token', {
            returnUrl: `${WEB_ORIGIN}/onboarding/paypal/return`,
          })
        ).body.setupTokenId as string;
      const stale = await setup(user);
      const mine = await setup(user);
      const foreign = await setup(other);

      for (const setupTokenId of [stale, foreign, 'SETUP-unknown']) {
        const res = await as(user, ['vault:manage'], 'POST', '/human/vault/payment-token', {
          setupTokenId,
        });
        expect(res.status).toBe(404);
      }
      expect(vaultCalls.filter((c) => c.startsWith('createPaymentToken'))).toEqual([]);

      const res = await as(user, ['vault:manage'], 'POST', '/human/vault/payment-token', {
        setupTokenId: mine,
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ connected: true });
      const rows = await conn.db.select().from(vaultTokens).where(eq(vaultTokens.userId, user.id));
      expect(rows.filter((r) => r.status === 'active').map((r) => r.paymentTokenId)).toEqual([
        `PT-${mine}`,
      ]);
      expect(rows.filter((r) => r.status === 'deleted')).toHaveLength(1);
    });

    it('DELETE /human/vault is forbidden for judge_demo and works for a user', async () => {
      const judge = await newUser('judge_demo');
      await connectVault(judge.id);
      const denied = await as(judge, ['vault:manage'], 'DELETE', '/human/vault');
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(vaultCalls).toEqual([]);

      const user = await newUser();
      expect((await as(user, ['vault:manage'], 'DELETE', '/human/vault')).status).toBe(404);
      await connectVault(user.id);
      const ok = await as(user, ['vault:manage'], 'DELETE', '/human/vault');
      expect(ok.status).toBe(200);
      expect(vaultCalls).toHaveLength(1);
      const [row] = await conn.db.select().from(vaultTokens).where(eq(vaultTokens.userId, user.id));
      expect(row?.status).toBe('deleted');
    });
  });

  // ---- rules -------------------------------------------------------------------------------

  describe('rules', () => {
    it('signs a card that verifyCard accepts, owned by the asserted user', async () => {
      const user = await newUser();
      const id = await newDraft(user.id, draftRules({ userId: randomUUID(), version: 99 }));
      const res = await as(user, ['rules:sign'], 'POST', `/human/rules/${id}/sign`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id,
        version: expect.any(Number),
        fingerprint: expect.any(String),
      });

      const [row] = await conn.db.select().from(ruleCards).where(eq(ruleCards.id, id));
      expect(row?.status).toBe('signed');
      const card = verifyCard(
        { card: row?.rules, keyId: row?.keyId, alg: 'HS256', sig: row?.hmac },
        { [KEY.id]: KEY.secret },
        new Date(),
      );
      expect(card.userId).toBe(user.id);
      expect(card.version).toBe(res.body.version);
      expect(row?.hmac?.slice(0, 8)).toBe(res.body.fingerprint);
    });

    it('bumps the version and revokes the previous signed card', async () => {
      const user = await newUser();
      const first = await as(
        user,
        ['rules:sign'],
        'POST',
        `/human/rules/${await newDraft(user.id)}/sign`,
      );
      const secondId = await newDraft(user.id);
      const second = await as(user, ['rules:sign'], 'POST', `/human/rules/${secondId}/sign`);
      expect(second.body.version).toBeGreaterThan(first.body.version as number);
      const rows = await conn.db.select().from(ruleCards).where(eq(ruleCards.userId, user.id));
      const statusOf = (id: unknown) => rows.find((r) => r.id === id)?.status;
      expect(statusOf(first.body.id)).toBe('revoked');
      expect(statusOf(secondId)).toBe('signed');
    });

    it('rejects a draft that violates the schema with 422 and field paths', async () => {
      const user = await newUser();
      const id = await newDraft(
        user.id,
        draftRules({ perItemCapCents: -5, frequency: { maxPurchases: 1, windowHours: 0 } }),
      );
      const res = await as(user, ['rules:sign'], 'POST', `/human/rules/${id}/sign`);
      expect(res.status).toBe(422);
      const error = res.body.error as { code: string; message: string };
      expect(error.code).toBe('RULE_CARD_INVALID');
      expect(error.message).toContain('perItemCapCents');
      expect(error.message).toContain('frequency.windowHours');
      const [row] = await conn.db.select().from(ruleCards).where(eq(ruleCards.id, id));
      expect(row?.status).toBe('draft');
    });

    it("returns 404, never 403, for another user's card", async () => {
      const owner = await newUser();
      const intruder = await newUser();
      const draft = await newDraft(owner.id);
      const signed = await signDraft(owner);
      for (const url of [`/human/rules/${draft}/sign`, `/human/rules/${signed}/revoke`]) {
        const res = await as(intruder, ['rules:sign'], 'POST', url);
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
      }
      expect((await as(intruder, ['rules:sign'], 'POST', '/human/rules/nope/sign')).status).toBe(
        404,
      );
      const rows = await conn.db.select().from(ruleCards).where(eq(ruleCards.userId, owner.id));
      expect(rows.find((r) => r.id === draft)?.status).toBe('draft');
      expect(rows.find((r) => r.id === signed)?.status).toBe('signed');
    });
  });

  // ---- sessions and the agent endpoint -----------------------------------------------------

  describe('sessions', () => {
    const body = { mode: 'demo', model: 'test-model' };

    it('needs a connected wallet, then signed rules', async () => {
      const user = await newUser();
      let res = await as(user, ['sessions:create'], 'POST', '/human/sessions', body);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: { code: 'CONFLICT', message: 'Connect PayPal first' },
      });
      await connectVault(user.id);
      res = await as(user, ['sessions:create'], 'POST', '/human/sessions', body);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: { code: 'CONFLICT', message: 'Sign your rules first' },
      });
    });

    it('returns the agent token once and stores only its hash', async () => {
      const user = await newUser();
      await connectVault(user.id);
      const cardId = await signDraft(user);
      const res = await as(user, ['sessions:create'], 'POST', '/human/sessions', body);
      expect(res.status).toBe(200);
      const { sessionId, token } = res.body as { sessionId: string; token: string };
      const [row] = await conn.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId));
      expect(row).toMatchObject({ userId: user.id, ruleCardId: cardId, mode: 'demo' });
      expect(JSON.stringify(row)).not.toContain(token);
    });

    it('editing the signed rules in the database makes the agent endpoint block', async () => {
      const user = await newUser();
      await connectVault(user.id);
      const cardId = await signDraft(user);
      const { token } = (await as(user, ['sessions:create'], 'POST', '/human/sessions', body))
        .body as { token: string };

      const [row] = await conn.db.select().from(ruleCards).where(eq(ruleCards.id, cardId));
      const rules = row?.rules as Record<string, unknown>;
      await conn.db
        .update(ruleCards)
        .set({ rules: { ...rules, perItemCapCents: 1_000_000, perOrderCapCents: 1_000_000 } })
        .where(eq(ruleCards.id, cardId));

      const res = await propose(token);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        decision: 'blocked',
        blockedBy: 'rule_card_invalid',
        paypalOrderCreated: false,
      });
      expect(res.body.reason).toMatch(/No PayPal order created\.$/);
    });

    it('revoking the card makes the agent endpoint block', async () => {
      const user = await newUser();
      await connectVault(user.id);
      const cardId = await signDraft(user);
      const { token } = (await as(user, ['sessions:create'], 'POST', '/human/sessions', body))
        .body as { token: string };
      const res = await as(user, ['rules:sign'], 'POST', `/human/rules/${cardId}/revoke`);
      expect(res.status).toBe(200);
      expect((await propose(token)).body).toMatchObject({
        decision: 'blocked',
        blockedBy: 'rule_card_invalid',
      });
    });
  });

  it('the agent token never becomes a human even with a valid-looking session', async () => {
    const { token } = mintAgentToken(PEPPER);
    const res = await call('GET', '/human/me', token);
    expect(res.status).toBe(401);
  });
});
