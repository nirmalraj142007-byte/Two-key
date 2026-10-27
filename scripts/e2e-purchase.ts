/**
 * End-to-end purchase pipeline against the REAL PayPal sandbox and the LOCAL database.
 *
 *   npm run e2e:purchase
 *
 * Bootstraps (idempotently) its own test user e2e@twokey.demo, the vaulted wallet from
 * spikes/results/vault.json, a signed rule card and a fresh demo agent session, starts the
 * gateway in-process and proposes three purchases: one captured, one blocked (no PayPal order)
 * and one held. The held row prints its approval ID for POST /human/approvals/:id.
 *
 * Needs `docker compose up -d`, `npm run db:migrate` and `npm run db:seed` first. The card
 * allows 50 purchases per 24 h, so repeated runs never hit the frequency rule. The hold's
 * timer is queued in pg-boss; a running gateway (`npm run dev`) voids it at the deadline.
 */
import { readFileSync } from 'node:fs';
import { AppError, ErrorCode, loadEnv, type RuleCard, signCard, verifyCard } from '@twokey/core';
import {
  agentSessions,
  approvals,
  catalogSnapshots,
  createDb,
  listings,
  merchants,
  payments,
  ruleCards,
  users,
  vaultTokens,
} from '@twokey/db';
import { buildApp, loadRuleKeys, mintAgentToken, webPushSender } from '@twokey/gateway';
import { and, desc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';

const EMAIL = 'e2e@twokey.demo';
const MAX_PURCHASES = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

const VaultFile = z.object({ paymentTokenId: z.string().min(1), customerId: z.string().min(1) });

const ProposalResult = z.object({
  proposalId: z.string(),
  decision: z.string(),
  reason: z.string(),
  paypalOrderCreated: z.boolean(),
});

const env = loadEnv('gateway');
const dbHost = new URL(env.DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(dbHost)) {
  console.error(`e2e:purchase only runs against a local database (DATABASE_URL host is ${dbHost})`);
  process.exit(1);
}

const { db, sql } = createDb(env.DATABASE_URL);
const keys = loadRuleKeys(env);

async function bootstrap() {
  const vault = VaultFile.parse(
    JSON.parse(readFileSync(new URL('../spikes/results/vault.json', import.meta.url), 'utf8')),
  );

  await db
    .insert(users)
    .values({ email: EMAIL, displayName: 'E2E purchase' })
    .onConflictDoNothing({ target: users.email });
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, EMAIL));
  if (!user) throw new AppError(ErrorCode.INTERNAL, 'Could not create the demo user');

  // One active vault token per user: retire any other, then upsert the spike's token.
  await db
    .update(vaultTokens)
    .set({ status: 'deleted', deletedAt: new Date() })
    .where(
      and(
        eq(vaultTokens.userId, user.id),
        eq(vaultTokens.status, 'active'),
        ne(vaultTokens.paymentTokenId, vault.paymentTokenId),
      ),
    );
  await db
    .insert(vaultTokens)
    .values({
      userId: user.id,
      paypalCustomerId: vault.customerId,
      paymentTokenId: vault.paymentTokenId,
      status: 'active',
    })
    .onConflictDoUpdate({
      target: [vaultTokens.userId, vaultTokens.paymentTokenId],
      set: { status: 'active', deletedAt: null },
    });

  const merchantRows = await db.select().from(merchants);
  const merchantId = (slug: string) => {
    const m = merchantRows.find((r) => r.slug === slug);
    if (!m) throw new AppError(ErrorCode.CONFIG_INVALID, `Run npm run db:seed (no ${slug})`);
    return m.id;
  };
  const allowed = ['stride-supply', 'peak-outfitters', 'pacer-goods'].map(merchantId).sort();

  // Reuse the latest signed card while it still verifies with this key and has a day left.
  const now = new Date();
  const [latest] = await db
    .select()
    .from(ruleCards)
    .where(eq(ruleCards.userId, user.id))
    .orderBy(desc(ruleCards.version))
    .limit(1);
  let cardId: string | undefined;
  if (latest?.status === 'signed' && latest.hmac && latest.keyId) {
    try {
      const card = verifyCard(
        { card: latest.rules, keyId: latest.keyId, alg: 'HS256', sig: latest.hmac },
        keys,
        new Date(now.getTime() + DAY_MS),
      );
      if (
        [...card.allowedMerchantIds].sort().join() === allowed.join() &&
        card.frequency.maxPurchases === MAX_PURCHASES
      ) {
        cardId = latest.id;
      }
    } catch {
      // stale or signed with another key: sign a new version below
    }
  }
  if (!cardId) {
    const card: RuleCard = {
      version: (latest?.version ?? 0) + 1,
      userId: user.id,
      currency: 'USD',
      perItemCapCents: 7000,
      perOrderCapCents: 7000,
      allowedMerchantIds: allowed,
      maxQtyPerOrder: 1,
      frequency: { maxPurchases: MAX_PURCHASES, windowHours: 24 },
      holdTimeoutMinutes: 15,
      anomaly: { priceRatioThreshold: 1.3 },
      expiresAt: new Date(now.getTime() + 7 * DAY_MS).toISOString(),
      advisory: [{ key: 'size', value: '10', label: 'Size 10' }],
    };
    const signed = signCard(card, {
      id: env.RULE_HMAC_KEY_ID,
      secret: keys[env.RULE_HMAC_KEY_ID] as Buffer,
    });
    if (latest?.status === 'signed') {
      await db.update(ruleCards).set({ status: 'revoked' }).where(eq(ruleCards.id, latest.id));
    }
    const [row] = await db
      .insert(ruleCards)
      .values({
        userId: user.id,
        version: card.version,
        status: 'signed',
        nlRequest:
          'Running shoes, size 10, under $70, only Stride Supply or Peak Outfitters, one pair, this week.',
        rules: signed.card,
        enforcement: {},
        signedAt: now,
        expiresAt: new Date(card.expiresAt),
        hmac: signed.sig,
        keyId: signed.keyId,
      })
      .returning({ id: ruleCards.id });
    cardId = row?.id;
  }
  if (!cardId) throw new AppError(ErrorCode.INTERNAL, 'Could not create the rule card');

  // Tokens are stored only as hashes, so every run ends the previous session and mints a new one.
  await db
    .update(agentSessions)
    .set({ status: 'ended', endedAt: now })
    .where(and(eq(agentSessions.userId, user.id), eq(agentSessions.status, 'active')));
  const { token, hash } = mintAgentToken(env.AGENT_TOKEN_PEPPER);
  await db.insert(agentSessions).values({
    userId: user.id,
    ruleCardId: cardId,
    mode: 'demo',
    model: 'e2e-purchase',
    agentTokenHash: hash,
  });
  return token;
}

async function demoListing(groupKey: string, slug: string) {
  const [row] = await db
    .select({ id: listings.id, title: listings.title })
    .from(listings)
    .innerJoin(merchants, eq(merchants.id, listings.merchantId))
    .innerJoin(catalogSnapshots, eq(catalogSnapshots.id, listings.snapshotId))
    .where(
      and(
        eq(listings.groupKey, groupKey),
        eq(merchants.slug, slug),
        eq(catalogSnapshots.kind, 'demo_unbranded'),
      ),
    )
    .limit(1);
  if (!row) throw new AppError(ErrorCode.CONFIG_INVALID, `Run npm run db:seed (no ${groupKey})`);
  return { ...row, slug };
}

const token = await bootstrap();
const products = [
  await demoListing('cloud-runner-cr1', 'stride-supply'),
  await demoListing('giftvault-gift-card-189', 'giftvault'),
  await demoListing('trail-runner-tr2', 'peak-outfitters'),
];

// The hold's phone push: record each push service's HTTP status (never the endpoint or keys).
const pushStatuses: number[] = [];
const sender = env.VAPID_SUBJECT
  ? webPushSender({
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT,
    })
  : undefined;
const app = buildApp(
  { ...env, LOG_LEVEL: 'warn' },
  sender
    ? {
        sendPush: async (sub, payload) => {
          const status = await sender(sub, payload);
          pushStatuses.push(status);
          return status;
        },
      }
    : {},
);
let exitCode = 0;
try {
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const rows: string[][] = [];
  for (const p of products) {
    const res = await fetch(`${address}/agent/proposals`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ product_id: p.id, qty: 1 }),
    });
    const json: unknown = await res.json();
    const parsed = ProposalResult.safeParse(json);
    if (!res.ok || !parsed.success) {
      exitCode = 1;
      rows.push([
        p.title,
        p.slug,
        `HTTP ${res.status}`,
        '-',
        '-',
        '-',
        '-',
        '-',
        JSON.stringify(json),
      ]);
      continue;
    }
    const r = parsed.data;
    const [pay] = await db
      .select({
        order: payments.paypalOrderId,
        auth: payments.paypalAuthorizationId,
        capture: payments.paypalCaptureId,
        state: payments.state,
        approval: approvals.id,
      })
      .from(payments)
      .leftJoin(approvals, eq(approvals.paymentId, payments.id))
      .where(eq(payments.proposalId, r.proposalId));
    rows.push([
      p.title,
      p.slug,
      r.decision,
      pay?.state ?? '-',
      pay?.approval ?? '-',
      pay?.order ?? '-',
      pay?.auth ?? '-',
      pay?.capture ?? '-',
      r.reason,
    ]);
  }

  const header = [
    'product',
    'merchant',
    'decision',
    'state',
    'approval',
    'paypal order',
    'authorization',
    'capture',
    'reason',
  ];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  console.log(line(header));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) console.log(line(r));

  const decisions = rows.map((r) => r[2]).join(',');
  if (decisions !== 'captured,blocked,held') {
    console.error(`\nexpected captured,blocked,held; got ${decisions}`);
    exitCode = 1;
  }
} finally {
  // close() waits for the hold's push, which is sent without blocking the purchase.
  await app.close();
  await sql.end();
}
console.log(
  !sender
    ? '\npush: off (VAPID_SUBJECT not set)'
    : pushStatuses.length === 0
      ? '\npush: no devices subscribed for e2e@twokey.demo'
      : `\npush: ${pushStatuses.length} device(s), push service HTTP ${pushStatuses.join(', ')}`,
);
process.exit(exitCode);
