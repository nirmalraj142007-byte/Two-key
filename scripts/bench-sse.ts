/**
 * Webhook -> UI benchmark (phase 29): subscribes to the gateway's /human/events stream, then 10
 * times inserts a verified webhook_events row and applies it (applyWebhookEvent, as the
 * webhook route does) to a payment of a throwaway user, and measures how long the matching
 * event takes to reach the stream.
 *
 *   npx tsx scripts/bench-sse.ts [--events 10]
 *
 * Reads DATABASE_URL from .env.gateway and HUMAN_ASSERTION_PRIVATE_KEY from .env.web (local
 * database only). The throwaway user, card, session, proposals and payments are removed
 * afterwards. GATEWAY_URL overrides the target (default 127.0.0.1, see bench-blocked.ts); the
 * evaluation gateway (port 4010) is refused. Exit code is 1 when p95 >= 2000 ms.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { GATE_VERSION, RuleCardSchema } from '@twokey/core';
import {
  agentSessions,
  catalogSnapshots,
  createDb,
  gateDecisions,
  listings,
  merchants,
  paymentEvents,
  payments,
  proposals,
  ruleCards,
  users,
  webhookEvents,
} from '@twokey/db';
import { and, eq, inArray, like } from 'drizzle-orm';
import { importPKCS8, SignJWT } from 'jose';
import { applyWebhookEvent } from '../apps/gateway/src/services/webhook-apply.js';

const BENCH_EMAIL = 'bench-sse@twokey.system';
const P95_TARGET_MS = 2000;
const at = process.argv.indexOf('--events');
const eventCount = at === -1 ? 10 : Number(process.argv[at + 1]);
if (!Number.isInteger(eventCount) || eventCount < 1) throw new Error('--events needs an integer');

const gatewayUrl = process.env.GATEWAY_URL ?? 'http://127.0.0.1:4000';
if (new URL(gatewayUrl).port === '4010') throw new Error('refusing to benchmark the eval gateway');

const read = (name: string) =>
  parseEnv(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
const databaseUrl = read('.env.gateway').DATABASE_URL;
const privatePem = read('.env.web').HUMAN_ASSERTION_PRIVATE_KEY;
if (!databaseUrl || !privatePem) {
  throw new Error('needs DATABASE_URL in .env.gateway and HUMAN_ASSERTION_PRIVATE_KEY in .env.web');
}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('bench-sse only runs against a local database');
}
const { db, sql } = createDb(databaseUrl);

async function cleanup(): Promise<void> {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, BENCH_EMAIL));
  if (!user) return;
  const sessionIds = (
    await db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(eq(agentSessions.userId, user.id))
  ).map((s) => s.id);
  if (sessionIds.length > 0) {
    const props = db
      .select({ id: proposals.id })
      .from(proposals)
      .where(inArray(proposals.sessionId, sessionIds));
    const pays = db
      .select({ id: payments.id })
      .from(payments)
      .where(inArray(payments.proposalId, props));
    await db.delete(paymentEvents).where(inArray(paymentEvents.paymentId, pays));
    await db.delete(payments).where(inArray(payments.proposalId, props));
    await db.delete(gateDecisions).where(inArray(gateDecisions.proposalId, props));
    await db.delete(proposals).where(inArray(proposals.sessionId, sessionIds));
    await db.delete(agentSessions).where(inArray(agentSessions.id, sessionIds));
  }
  await db.delete(ruleCards).where(eq(ruleCards.userId, user.id));
  await db.delete(users).where(eq(users.id, user.id));
  await db.delete(webhookEvents).where(like(webhookEvents.paypalEventId, 'BENCH-EVT-%'));
}

const benchIds: string[] = [];
const runId = randomUUID().slice(0, 8);

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

const abort = new AbortController();
try {
  await cleanup();
  const [listing] = await db
    .select({ id: listings.id, merchantId: listings.merchantId })
    .from(listings)
    .innerJoin(catalogSnapshots, eq(catalogSnapshots.id, listings.snapshotId))
    .innerJoin(merchants, eq(merchants.id, listings.merchantId))
    .where(and(eq(merchants.slug, 'stride-supply'), eq(catalogSnapshots.kind, 'demo_unbranded')))
    .limit(1);
  if (!listing) throw new Error('demo catalog missing: run npm run db:seed');

  const [user] = await db
    .insert(users)
    .values({ email: BENCH_EMAIL, displayName: 'Bench', role: 'user' })
    .returning({ id: users.id });
  if (!user) throw new Error('user insert failed');
  const expiresAt = new Date(Date.now() + 86_400_000);
  const [card] = await db
    .insert(ruleCards)
    .values({
      userId: user.id,
      version: 1,
      status: 'draft',
      nlRequest: 'Benchmark.',
      rules: RuleCardSchema.parse({
        version: 1,
        userId: user.id,
        currency: 'USD',
        perItemCapCents: 7000,
        perOrderCapCents: 7000,
        allowedMerchantIds: [listing.merchantId],
        maxQtyPerOrder: 1,
        frequency: { maxPurchases: 50, windowHours: 24 },
        holdTimeoutMinutes: 15,
        anomaly: { priceRatioThreshold: 1.3 },
        expiresAt: expiresAt.toISOString(),
        advisory: [],
      }),
      enforcement: {},
    })
    .returning({ id: ruleCards.id });
  const [session] = card
    ? await db
        .insert(agentSessions)
        .values({
          userId: user.id,
          ruleCardId: card.id,
          mode: 'demo',
          model: 'bench',
          agentTokenHash: `bench-${randomUUID()}`,
        })
        .returning({ id: agentSessions.id })
    : [];
  if (!card || !session) throw new Error('setup insert failed');

  const targets: { proposalId: string; authorizationId: string; eventId: string }[] = [];
  for (let i = 0; i < eventCount; i++) {
    const [proposal] = await db
      .insert(proposals)
      .values({
        sessionId: session.id,
        ruleCardId: card.id,
        listingId: listing.id,
        qty: 1,
        rawToolArgs: {},
        resolvedAmountCents: 5400,
        resolvedMerchantId: listing.merchantId,
      })
      .returning({ id: proposals.id });
    if (!proposal) throw new Error('proposal insert failed');
    await db.insert(gateDecisions).values({
      proposalId: proposal.id,
      gate: 'G4',
      outcome: 'capture',
      ruleHits: [],
      gateVersion: GATE_VERSION,
    });
    const authorizationId = `BENCH-AUTH-${runId}-${i}`;
    await db.insert(payments).values({
      proposalId: proposal.id,
      paypalAuthorizationId: authorizationId,
      payeeMerchantId: listing.merchantId,
      amountCents: 5400,
      state: 'capture_requested',
    });
    const eventId = `BENCH-EVT-${runId}-${i}`;
    benchIds.push(`BENCH-CAP-${runId}-${i}`);
    targets.push({ proposalId: proposal.id, authorizationId, eventId });
  }

  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ role: 'user', scope: 'events:read' })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('twokey-web')
    .setAudience('twokey-gateway')
    .setSubject(user.id)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(await importPKCS8(privatePem, 'EdDSA'));

  const res = await fetch(`${gatewayUrl}/human/events`, {
    headers: { authorization: `Bearer ${assertion}`, accept: 'text/event-stream' },
    signal: abort.signal,
  });
  if (res.status !== 200 || !res.body) throw new Error(`events stream refused: ${res.status}`);

  // Arrival time of the first chunk that mentions each proposal.
  const arrived = new Map<string, number>();
  let connected: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    connected = resolve;
  });
  void (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        const text = decoder.decode(chunk, { stream: true });
        const t = performance.now();
        if (text.includes(': connected')) connected();
        for (const target of targets) {
          if (!arrived.has(target.proposalId) && text.includes(target.proposalId)) {
            arrived.set(target.proposalId, t);
          }
        }
      }
    } catch {
      // aborted at the end of the run
    }
  })();
  await ready;

  const latencies: number[] = [];
  for (const [i, target] of targets.entries()) {
    const captureId = `BENCH-CAP-${runId}-${i}`;
    const raw = {
      id: target.eventId,
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: captureId,
        status: 'COMPLETED',
        supplementary_data: { related_ids: { authorization_id: target.authorizationId } },
      },
    };
    const [row] = await db
      .insert(webhookEvents)
      .values({
        paypalEventId: target.eventId,
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
        resourceId: captureId,
        verification: 'SUCCESS',
        raw,
      })
      .returning();
    if (!row) throw new Error('webhook row insert failed');
    const t0 = performance.now();
    const result = await applyWebhookEvent(db, row);
    if (result !== 'applied') throw new Error(`event ${i} was ${result}, not applied`);
    const deadline = t0 + 10_000;
    while (!arrived.has(target.proposalId) && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const t1 = arrived.get(target.proposalId);
    if (t1 === undefined) throw new Error(`event ${i} never reached the stream`);
    latencies.push(t1 - t0);
  }

  latencies.sort((a, b) => a - b);
  const p95 = percentile(latencies, 95);
  console.log(
    JSON.stringify(
      {
        target: `${gatewayUrl}/human/events`,
        events: latencies.length,
        p50Ms: Math.round(percentile(latencies, 50)),
        p95Ms: Math.round(p95),
        maxMs: Math.round(latencies.at(-1) ?? 0),
      },
      null,
      2,
    ),
  );
  console.log(
    p95 < P95_TARGET_MS
      ? `PASS: p95 ${Math.round(p95)} ms < ${P95_TARGET_MS} ms`
      : `FAIL: p95 ${Math.round(p95)} ms (target < ${P95_TARGET_MS})`,
  );
  process.exitCode = p95 < P95_TARGET_MS ? 0 : 1;
} finally {
  abort.abort();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await cleanup();
  await sql.end();
}
