/**
 * Blocked-decision benchmark (phase 29): POST /agent/proposals for the GiftVault gift card at
 * 20 requests/s, spread over many agent sessions so the gateway's 30-per-minute-per-session
 * limiter stays on. A blocked proposal makes zero PayPal calls by design.
 *
 *   npx tsx scripts/bench-blocked.ts [--rps 20] [--seconds 30] [--sessions 60]
 *
 * Reads DATABASE_URL, AGENT_TOKEN_PEPPER, RULE_HMAC_KEY(_ID) from .env.gateway (local database
 * only). Creates a throwaway user, signed rule card and sessions, and removes them (and their
 * proposals) afterwards. GATEWAY_URL overrides the target (default 127.0.0.1: on Windows "localhost"
 * tries ::1 first and adds ~200 ms to every new connection, which is not the gateway's time); the evaluation gateway (port 4010) is
 * refused. Exit code is 1 when p95 >= 150 ms or any request errored.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { RuleCardSchema, signCard } from '@twokey/core';
import {
  agentSessions,
  catalogSnapshots,
  createDb,
  gateDecisions,
  listings,
  merchants,
  proposals,
  ruleCards,
  users,
} from '@twokey/db';
import autocannon from 'autocannon';
import { and, eq, inArray } from 'drizzle-orm';

const BENCH_EMAIL = 'bench-blocked@twokey.system';
const P95_TARGET_MS = 150;

function numArg(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`);
  const v = at === -1 ? fallback : Number(process.argv[at + 1]);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} needs a positive number`);
  return v;
}
const rps = numArg('rps', 20);
const seconds = numArg('seconds', 30);
const sessionCount = numArg('sessions', 60);

const gatewayUrl = process.env.GATEWAY_URL ?? 'http://127.0.0.1:4000';
if (new URL(gatewayUrl).port === '4010') throw new Error('refusing to benchmark the eval gateway');

const env = parseEnv(readFileSync(new URL('../.env.gateway', import.meta.url), 'utf8'));
const { DATABASE_URL, AGENT_TOKEN_PEPPER, RULE_HMAC_KEY, RULE_HMAC_KEY_ID } = env;
if (!DATABASE_URL || !AGENT_TOKEN_PEPPER || !RULE_HMAC_KEY || !RULE_HMAC_KEY_ID) {
  throw new Error('needs DATABASE_URL, AGENT_TOKEN_PEPPER and RULE_HMAC_KEY(_ID) in .env.gateway');
}
const { db, sql } = createDb(DATABASE_URL);

async function cleanup(): Promise<void> {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, BENCH_EMAIL));
  if (!user) return;
  const sessions = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(eq(agentSessions.userId, user.id));
  const sessionIds = sessions.map((s) => s.id);
  if (sessionIds.length > 0) {
    const props = db
      .select({ id: proposals.id })
      .from(proposals)
      .where(inArray(proposals.sessionId, sessionIds));
    await db.delete(gateDecisions).where(inArray(gateDecisions.proposalId, props));
    await db.delete(proposals).where(inArray(proposals.sessionId, sessionIds));
    await db.delete(agentSessions).where(inArray(agentSessions.id, sessionIds));
  }
  await db.delete(ruleCards).where(eq(ruleCards.userId, user.id));
  await db.delete(users).where(eq(users.id, user.id));
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

try {
  await cleanup();

  const [gift] = await db
    .select({ id: listings.id })
    .from(listings)
    .innerJoin(catalogSnapshots, eq(catalogSnapshots.id, listings.snapshotId))
    .innerJoin(merchants, eq(merchants.id, listings.merchantId))
    .where(and(eq(merchants.slug, 'giftvault'), eq(catalogSnapshots.kind, 'demo_unbranded')))
    .limit(1);
  const [stride] = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(eq(merchants.slug, 'stride-supply'));
  if (!gift || !stride) throw new Error('demo catalog missing: run npm run db:seed');

  const [user] = await db
    .insert(users)
    .values({ email: BENCH_EMAIL, displayName: 'Bench', role: 'user' })
    .returning({ id: users.id });
  if (!user) throw new Error('user insert failed');
  const signedAt = new Date();
  const expiresAt = new Date(signedAt.getTime() + 86_400_000);
  const card = RuleCardSchema.parse({
    version: 1,
    userId: user.id,
    currency: 'USD',
    perItemCapCents: 7000,
    perOrderCapCents: 7000,
    allowedMerchantIds: [stride.id],
    maxQtyPerOrder: 1,
    frequency: { maxPurchases: 50, windowHours: 24 },
    holdTimeoutMinutes: 15,
    anomaly: { priceRatioThreshold: 1.3 },
    expiresAt: expiresAt.toISOString(),
    advisory: [],
  });
  const signed = signCard(card, {
    id: RULE_HMAC_KEY_ID,
    secret: Buffer.from(RULE_HMAC_KEY, 'base64'),
  });
  const [ruleCard] = await db
    .insert(ruleCards)
    .values({
      userId: user.id,
      version: 1,
      status: 'signed',
      nlRequest: 'Benchmark: Stride Supply only.',
      rules: signed.card,
      enforcement: {},
      signedAt,
      expiresAt,
      hmac: signed.sig,
      keyId: signed.keyId,
    })
    .returning({ id: ruleCards.id });
  if (!ruleCard) throw new Error('rule card insert failed');

  const tokens = Array.from(
    { length: sessionCount },
    () => `tk_agent_${randomBytes(32).toString('base64url')}`,
  );
  await db.insert(agentSessions).values(
    tokens.map((token) => ({
      userId: user.id,
      ruleCardId: ruleCard.id,
      mode: 'demo' as const,
      model: 'bench',
      agentTokenHash: createHash('sha256')
        .update(AGENT_TOKEN_PEPPER + token, 'utf8')
        .digest('hex'),
    })),
  );

  const body = JSON.stringify({ product_id: gift.id, qty: 1 });
  const url = `${gatewayUrl}/agent/proposals`;

  // One request per session first: checks the decision shape and warms the gateway's pool.
  for (const token of tokens.slice(0, 3)) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body,
    });
    const json = (await res.json()) as { decision?: string; paypalOrderCreated?: boolean };
    if (res.status !== 200 || json.decision !== 'blocked' || json.paypalOrderCreated !== false) {
      throw new Error(`unexpected warm-up response ${res.status}: ${JSON.stringify(json)}`);
    }
  }

  const times: number[] = [];
  const statuses = new Map<number, number>();
  let next = 0;
  const result = await new Promise<autocannon.Result>((resolve, reject) => {
    const instance = autocannon(
      {
        url,
        method: 'POST',
        connections: 10,
        duration: seconds,
        overallRate: rps,
        headers: { 'content-type': 'application/json' },
        body,
        requests: [
          {
            setupRequest: (req) => {
              const token = tokens[next++ % tokens.length];
              return { ...req, headers: { ...req.headers, authorization: `Bearer ${token}` } };
            },
          },
        ],
      },
      (err, res) => (err ? reject(err) : resolve(res)),
    );
    instance.on('response', (_client, statusCode, _bytes, responseTime) => {
      statuses.set(statusCode, (statuses.get(statusCode) ?? 0) + 1);
      times.push(responseTime);
    });
  });

  times.sort((a, b) => a - b);
  const bad = [...statuses].filter(([s]) => s !== 200).reduce((n, [, c]) => n + c, 0);
  const errors = result.errors + result.timeouts + bad;
  const p95 = percentile(times, 95);
  console.log(
    JSON.stringify(
      {
        target: url,
        rps,
        seconds,
        sessions: sessionCount,
        requests: times.length,
        statuses: Object.fromEntries(statuses),
        errors,
        p50Ms: percentile(times, 50),
        p95Ms: p95,
        p99Ms: percentile(times, 99),
        maxMs: times.at(-1) ?? 0,
      },
      null,
      2,
    ),
  );
  console.log(
    p95 < P95_TARGET_MS && errors === 0
      ? `PASS: p95 ${p95} ms < ${P95_TARGET_MS} ms, 0 errors`
      : `FAIL: p95 ${p95} ms (target < ${P95_TARGET_MS}), ${errors} errors`,
  );
  process.exitCode = p95 < P95_TARGET_MS && errors === 0 ? 0 : 1;
} finally {
  // Requests still in flight when autocannon stops finish on the gateway; let them land first.
  let cleanupError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      await cleanup();
      cleanupError = undefined;
      break;
    } catch (err) {
      cleanupError = err;
    }
  }
  await sql.end();
  if (cleanupError) console.error('cleanup failed; remove bench-blocked@twokey.system by hand');
}
