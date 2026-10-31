import { randomBytes, randomUUID } from 'node:crypto';
import { agentSessions, createDb, ruleCards, users } from '@twokey/db';
import { createTestDatabase, testDatabaseUrl } from '@twokey/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BODY_LIMIT_BYTES, buildApp, type PayPalOps } from '../src/app.js';
import { mintAgentToken } from '../src/auth/agent-token.js';
import { RATE_LIMITS } from '../src/rate-limits.js';

const PEPPER = 'test-pepper';
const KEY = { id: 'test-key', secret: randomBytes(32) };
const METRICS_TOKEN = randomBytes(32).toString('hex');
const WEB_ORIGIN = 'http://localhost:3000';
const PUBLIC_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=\n-----END PUBLIC KEY-----';
const noPayPal = async () => {
  throw new Error('no PayPal in this test');
};

describe('gateway without a database', () => {
  const apps: FastifyInstance[] = [];
  const build = (env: Partial<Parameters<typeof buildApp>[0]> = {}) => {
    const app = buildApp({ LOG_LEVEL: 'silent', METRICS_TOKEN, ...env });
    apps.push(app);
    return app;
  };
  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
  });

  it('answers /metrics 401 without the token, with a wrong one, and when none is configured', async () => {
    const app = build();
    expect((await app.inject({ url: '/metrics' })).statusCode).toBe(401);
    const wrong = await app.inject({
      url: '/metrics',
      headers: { authorization: `Bearer ${'x'.repeat(64)}` },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    const unset = buildApp({ LOG_LEVEL: 'silent' });
    apps.push(unset);
    const res = await unset.inject({
      url: '/metrics',
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('serves the five Two-Key metrics with the token', async () => {
    const res = await build().inject({
      url: '/metrics',
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    for (const name of [
      'twokey_decisions_total',
      'twokey_paypal_requests_total',
      'twokey_webhook_events_total',
      'twokey_open_authorizations',
      'twokey_webhook_lag_seconds',
    ]) {
      expect(res.body).toContain(`# TYPE ${name}`);
    }
  });

  it('keeps an incoming UUID x-request-id and replaces anything else', async () => {
    const app = build();
    const id = randomUUID();
    const kept = await app.inject({ url: '/healthz', headers: { 'x-request-id': id } });
    expect(kept.headers['x-request-id']).toBe(id);
    const replaced = await app.inject({
      url: '/healthz',
      headers: { 'x-request-id': 'evil\ninjected' },
    });
    expect(replaced.headers['x-request-id']).not.toBe('evil\ninjected');
    expect(String(replaced.headers['x-request-id'])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sends helmet headers', async () => {
    const res = await build().inject({ url: '/healthz' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('refuses bodies over 64 KB with the standard error body', async () => {
    const res = await build().inject({
      method: 'POST',
      url: '/agent/proposals',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ pad: 'x'.repeat(BODY_LIMIT_BYTES) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION' } });
  });

  it('rate-limits PayPal webhook deliveries to 600 a minute', async () => {
    const app = build();
    let last = 0;
    for (let i = 0; i <= RATE_LIMITS.webhooks; i++) {
      last = (
        await app.inject({
          method: 'POST',
          url: '/webhooks/paypal',
          headers: { 'content-type': 'application/json' },
          payload: '{}',
        })
      ).statusCode;
    }
    expect(last).toBe(429);
  });

  it('never starts with EVAL_ENABLED on a -prod Render service, whatever NODE_ENV says', () => {
    expect(() =>
      buildApp({
        LOG_LEVEL: 'silent',
        NODE_ENV: 'development',
        EVAL_ENABLED: true,
        RENDER_SERVICE_NAME: 'gateway-prod',
      }),
    ).toThrow(/production/);
  });
});

const baseUrl = testDatabaseUrl();

describe.skipIf(!baseUrl)('gateway with a database', () => {
  let drop = async () => {};
  let conn: ReturnType<typeof createDb>;
  let app: FastifyInstance;

  async function newSessionToken(): Promise<string> {
    const [user] = await conn.db
      .insert(users)
      .values({ email: `${randomUUID()}@test.local`, displayName: 'T' })
      .returning({ id: users.id });
    const userId = (user as { id: string }).id;
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
    const { token, hash } = mintAgentToken(PEPPER);
    await conn.db.insert(agentSessions).values({
      userId,
      ruleCardId: (card as { id: string }).id,
      mode: 'demo',
      model: 'test',
      agentTokenHash: hash,
    });
    return token;
  }

  beforeAll(async () => {
    let url: string;
    ({ url, drop } = await createTestDatabase(baseUrl as string));
    conn = createDb(url);
    app = buildApp(
      {
        LOG_LEVEL: 'silent',
        DATABASE_URL: url,
        RULE_HMAC_KEY: KEY.secret.toString('base64'),
        RULE_HMAC_KEY_ID: KEY.id,
        AGENT_TOKEN_PEPPER: PEPPER,
        HUMAN_ASSERTION_PUBLIC_KEY: PUBLIC_PEM,
        WEB_ORIGIN,
      },
      {
        paypal: {
          createVaultedAuthorization: noPayPal,
          capture: noPayPal,
          getAuthorization: noPayPal,
          getCapture: noPayPal,
        } as PayPalOps,
        vault: {
          createSetupToken: noPayPal,
          createPaymentToken: noPayPal,
          deletePaymentToken: noPayPal,
        },
      },
    );
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await conn?.sql.end();
    await drop();
  });

  it('allows the web origin on /human/* and /public/*, and no origin elsewhere', async () => {
    const human = await app.inject({ url: '/human/me', headers: { origin: WEB_ORIGIN } });
    expect(human.statusCode).toBe(401);
    expect(human.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    const pub = await app.inject({
      url: `/public/hijack/${randomUUID()}/events?t=x`,
      headers: { origin: WEB_ORIGIN },
    });
    expect(pub.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    for (const url of ['/agent/rules', '/healthz', '/metrics']) {
      const res = await app.inject({ url, headers: { origin: WEB_ORIGIN } });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/agent/proposals',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('limits /public/* to 60 a minute per client IP, keyed on the rightmost x-forwarded-for entry', async () => {
    const url = `/public/hijack/${randomUUID()}/events?t=x`;
    const real = '203.0.113.50';
    const hit = (xff: string) => app.inject({ url, headers: { 'x-forwarded-for': xff } });
    for (let i = 0; i < RATE_LIMITS.public; i++) {
      // A different faked left-most entry every time must not buy a fresh allowance.
      expect((await hit(`10.0.0.${i}, ${real}`)).statusCode).toBe(404);
    }
    const limited = await hit(`198.51.100.99, ${real}`);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(limited.headers['retry-after']).toBeDefined();
    // Another client (another rightmost entry) is unaffected.
    expect((await hit(`10.0.0.1, 203.0.113.51`)).statusCode).toBe(404);
  });

  it('limits /agent/proposals to 30 a minute per agent session', async () => {
    const a = await newSessionToken();
    const b = await newSessionToken();
    const propose = (token: string) =>
      app.inject({
        method: 'POST',
        url: '/agent/proposals',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
    for (let i = 0; i < RATE_LIMITS.proposals; i++) {
      expect((await propose(a)).statusCode).toBe(400);
    }
    expect((await propose(a)).statusCode).toBe(429);
    expect((await propose(b)).statusCode).toBe(400);
    // A bad token is refused before the limiter, so it can't spend a session's allowance.
    const bad = await app.inject({
      method: 'POST',
      url: '/agent/proposals',
      headers: { authorization: 'Bearer tk_agent_nope' },
      payload: {},
    });
    expect(bad.statusCode).toBe(401);
  });

  it('rejects agent tokens on /human/* and keeps /internal/eval unmounted', async () => {
    const token = await newSessionToken();
    const human = await app.inject({
      url: '/human/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(human.statusCode).toBe(401);
    const evalRoute = await app.inject({
      method: 'POST',
      url: '/internal/eval/sessions',
      payload: {},
    });
    expect(evalRoute.statusCode).toBe(404);
  });
});
