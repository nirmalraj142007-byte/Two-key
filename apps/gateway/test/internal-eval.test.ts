import { randomBytes } from 'node:crypto';
import {
  agentSessions,
  catalogSnapshots,
  createDb,
  evalEpisodeListings,
  evalEpisodes,
  evalTasks,
  listings,
  merchants,
  ruleCards,
} from '@twokey/db';
import { createTestDatabase, runSeed, testDatabaseUrl } from '@twokey/db/testing';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type PayPalOps } from '../src/app.js';

const PEPPER = 'test-pepper';
const KEY = { id: 'test-key', secret: randomBytes(32) };
const ADMIN = randomBytes(32).toString('base64');
const baseUrl = testDatabaseUrl();

describe.skipIf(!baseUrl)('POST /internal/eval/sessions', () => {
  let drop = async () => {};
  let conn: ReturnType<typeof createDb>;
  let url = '';
  const apps: FastifyInstance[] = [];
  const ids = { episode: '', listings: [] as string[] };

  function build(evalEnabled: boolean): FastifyInstance {
    const app = buildApp(
      {
        LOG_LEVEL: 'silent',
        DATABASE_URL: url,
        RULE_HMAC_KEY: KEY.secret.toString('base64'),
        RULE_HMAC_KEY_ID: KEY.id,
        AGENT_TOKEN_PEPPER: PEPPER,
        EVAL_ENABLED: evalEnabled,
        EVAL_ADMIN_TOKEN: ADMIN,
      },
      { paypal: {} as PayPalOps },
    );
    apps.push(app);
    return app;
  }

  const mint = (app: FastifyInstance, token: string | undefined, body: unknown) =>
    app.inject({
      method: 'POST',
      url: '/internal/eval/sessions',
      headers: token === undefined ? {} : { 'x-eval-token': token },
      payload: body as object,
    });

  beforeAll(async () => {
    ({ url, drop } = await createTestDatabase(baseUrl as string));
    await runSeed(url);
    conn = createDb(url);
    const { db } = conn;
    const [stride] = await db
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.slug, 'stride-supply'));
    const merchantId = (stride as { id: string }).id;
    const [snap] = await db
      .insert(catalogSnapshots)
      .values({ kind: 'eval_frozen', contentSha256: 'test', gitTag: 'test' })
      .returning({ id: catalogSnapshots.id });
    for (let i = 0; i < 12; i++) {
      const [row] = await db
        .insert(listings)
        .values({
          snapshotId: (snap as { id: string }).id,
          groupKey: `g${i}`,
          merchantId,
          title: `Listing ${i}`,
          category: 'other',
          priceCents: 1000 + i,
          description: `text ${i}`,
        })
        .returning({ id: listings.id });
      ids.listings.push((row as { id: string }).id);
    }
    const card = {
      currency: 'USD',
      perItemCapCents: 5000,
      perOrderCapCents: 5000,
      maxQtyPerOrder: 1,
      allowedMerchantIds: [merchantId],
      frequency: { maxPurchases: 5, windowHours: 24 },
      holdTimeoutMinutes: 60,
      anomaly: { priceRatioThreshold: 1.3 },
      expiresAt: '2027-01-01T00:00:00.000Z',
      advisory: [],
    };
    const [task] = await db
      .insert(evalTasks)
      .values({
        split: 'dev',
        webshopInstructionId: 'T1',
        instructionText: 'buy a thing',
        priceCapCents: 5000,
        category: 'other',
        goalAttrs: { sampleIndex: 0, evalCard: card },
        sampleSeed: 'seed',
      })
      .returning({ id: evalTasks.id });
    const taskId = (task as { id: string }).id;
    const episodeIds: string[] = [];
    for (const variant of ['clean', 'injecagent'] as const) {
      const [ep] = await db
        .insert(evalEpisodes)
        .values({ taskId, variant, contentSha256: variant })
        .returning({ id: evalEpisodes.id });
      episodeIds.push((ep as { id: string }).id);
    }
    ids.episode = episodeIds[0] as string;
    // Stored out of order on purpose: search must sort by position.
    const positions = ids.listings
      .map((listingId, position) => ({ listingId, position }))
      .reverse();
    await db
      .insert(evalEpisodeListings)
      .values(positions.map((p) => ({ episodeId: ids.episode, ...p })));
  });

  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
    await conn?.sql.end();
    await drop();
  });

  it('is not mounted unless EVAL_ENABLED', async () => {
    const res = await mint(build(false), ADMIN, { episodeId: ids.episode, model: 'm' });
    expect(res.statusCode).toBe(404);
  });

  it('refuses to build with EVAL_ENABLED in production', () => {
    expect(() =>
      buildApp({ LOG_LEVEL: 'silent', NODE_ENV: 'production', EVAL_ENABLED: true }),
    ).toThrow(/production/);
  });

  it('needs the eval token', async () => {
    const app = build(true);
    expect((await mint(app, undefined, { episodeId: ids.episode, model: 'm' })).statusCode).toBe(
      401,
    );
    expect((await mint(app, 'wrong', { episodeId: ids.episode, model: 'm' })).statusCode).toBe(401);
    expect((await mint(app, ADMIN, { episodeId: 'nope', model: 'm' })).statusCode).toBe(400);
  });

  it('creates an eval session on one signed card per task, and search returns the episode', async () => {
    const app = build(true);
    const first = await mint(app, ADMIN, { episodeId: ids.episode, model: 'm' });
    expect(first.statusCode).toBe(200);
    const a = first.json() as { sessionId: string; token: string };
    expect(a.token.startsWith('tk_agent_')).toBe(true);
    const second = (await mint(app, ADMIN, { episodeId: ids.episode, model: 'n' }).then((r) =>
      r.json(),
    )) as { sessionId: string };

    const sessions = await conn.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.evalEpisodeId, ids.episode));
    expect(sessions.map((s) => s.mode)).toEqual(['eval', 'eval']);
    expect(new Set(sessions.map((s) => s.ruleCardId)).size).toBe(1);
    expect(sessions.map((s) => s.id).sort()).toEqual([a.sessionId, second.sessionId].sort());
    const [card] = await conn.db
      .select()
      .from(ruleCards)
      .where(eq(ruleCards.id, sessions[0]?.ruleCardId as string));
    expect(card).toMatchObject({ status: 'signed', version: 1, keyId: KEY.id });

    // Any query gives the same first 10 listings, in position order.
    for (const q of ['buy%20a%20thing', 'zzz&limit=2&max_price_cents=1']) {
      const res = await app.inject({
        method: 'GET',
        url: `/agent/catalog/search?q=${q}`,
        headers: { authorization: `Bearer ${a.token}` },
      });
      const { items } = res.json() as { items: { product_id: string }[] };
      expect(items.map((i) => i.product_id)).toEqual(ids.listings.slice(0, 10));
    }
  });
});
