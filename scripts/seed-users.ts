/**
 * Upserts the demo users (idempotent):
 *
 *   npm run db:seed-users
 *   npm run db:seed-users -- --email newuser@example.test
 *
 * With --email, only that one account is upserted (role user, DEMO_PASSWORD): a fresh user for
 * walking through onboarding.
 *
 * maya@twokey.demo (user) and judge1–3@twokey.demo (judge_demo) get an argon2 hash of
 * DEMO_PASSWORD; hijack@twokey.system (hijack_system) has no password and cannot sign in.
 * Reads DATABASE_URL and DEMO_PASSWORD from .env.gateway. The password is never printed.
 *
 * The hijack user also gets (phase 22):
 * - its own active vault token from HIJACK_PAYPAL_PAYMENT_TOKEN_ID / HIJACK_PAYPAL_CUSTOMER_ID
 *   (created once by `npm run vault:hijack`). A token any other user holds is refused: payment
 *   tokens are never shared between users. The IDs are never printed.
 * - a signed rule card: Stride Supply, Peak Outfitters, Pacer Goods; $70 caps; one item;
 *   50 purchases per 24 h; 15-minute holds. Signed with RULE_HMAC_KEY (gateway env).
 */
import { hash } from '@node-rs/argon2';
import { RuleCardSchema, signCard } from '@twokey/core';
import { createDb, type Db, merchants, ruleCards, users, vaultTokens } from '@twokey/db';
import { and, eq, inArray, ne, sql as raw } from 'drizzle-orm';
import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  DEMO_PASSWORD: z.string().min(8, 'DEMO_PASSWORD must be at least 8 characters'),
  RULE_HMAC_KEY: z.string().min(1).optional(),
  RULE_HMAC_KEY_ID: z.string().min(1).optional(),
  HIJACK_PAYPAL_PAYMENT_TOKEN_ID: z.string().min(1).optional(),
  HIJACK_PAYPAL_CUSTOMER_ID: z.string().min(1).optional(),
});

const HIJACK_EMAIL = 'hijack@twokey.system';
const HIJACK_STORES = ['stride-supply', 'peak-outfitters', 'pacer-goods'];
const HIJACK_CARD_DAYS = 60;

type Seed = { email: string; displayName: string; role: 'user' | 'judge_demo' | 'hijack_system' };

const SEEDS: Seed[] = [
  { email: 'maya@twokey.demo', displayName: 'Maya', role: 'user' },
  { email: 'judge1@twokey.demo', displayName: 'Judge 1', role: 'judge_demo' },
  { email: 'judge2@twokey.demo', displayName: 'Judge 2', role: 'judge_demo' },
  { email: 'judge3@twokey.demo', displayName: 'Judge 3', role: 'judge_demo' },
  { email: 'hijack@twokey.system', displayName: 'Hijack system', role: 'hijack_system' },
];

function emailArg(argv: string[]): string | undefined {
  const at = argv.indexOf('--email');
  if (at === -1) return undefined;
  const email = z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email().max(254))
    .safeParse(argv[at + 1]);
  if (!email.success) {
    console.error('--email needs a valid email address');
    process.exit(1);
  }
  return email.data;
}

const onlyEmail = emailArg(process.argv.slice(2));
const seeds: Seed[] = onlyEmail
  ? [{ email: onlyEmail, displayName: onlyEmail.split('@')[0] ?? onlyEmail, role: 'user' }]
  : SEEDS;

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  const keys = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
  console.error(`db:seed-users needs ${keys.join(', ')} in .env.gateway`);
  process.exit(1);
}
const env = parsed.data;
const { db, sql } = createDb(env.DATABASE_URL);

try {
  const passwordHash = await hash(env.DEMO_PASSWORD);
  for (const seed of seeds) {
    const hashed = seed.role === 'hijack_system' ? null : passwordHash;
    await db
      .insert(users)
      .values({ ...seed, passwordHash: hashed })
      .onConflictDoUpdate({
        target: users.email,
        set: { displayName: seed.displayName, role: seed.role, passwordHash: hashed },
      });
    console.log(
      `${seed.email.padEnd(24)} ${seed.role.padEnd(14)} ${hashed ? 'password set' : 'no password'}`,
    );
  }
  const [row] = await db.execute<{ n: number }>(raw`select count(*)::int as n from users`);
  console.log(`users: ${row?.n ?? '?'}`);
  if (!onlyEmail) {
    const [hijack] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, HIJACK_EMAIL));
    if (!hijack) throw new Error('hijack user missing after upsert');
    console.log(`hijack vault: ${await seedHijackVault(db, hijack.id)}`);
    console.log(`hijack rules: ${await seedHijackCard(db, hijack.id)}`);
  }
} finally {
  await sql.end();
}

/** The hijack user's own wallet. Never a token another user holds; the IDs are never printed. */
async function seedHijackVault(db: Db, userId: string): Promise<string> {
  const tokenId = env.HIJACK_PAYPAL_PAYMENT_TOKEN_ID;
  const customerId = env.HIJACK_PAYPAL_CUSTOMER_ID;
  if (!tokenId || !customerId) {
    return 'not set (run npm run vault:hijack, then this again)';
  }
  const [other] = await db
    .select({ id: vaultTokens.id })
    .from(vaultTokens)
    .where(and(eq(vaultTokens.paymentTokenId, tokenId), ne(vaultTokens.userId, userId)))
    .limit(1);
  if (other) {
    console.error(
      'HIJACK_PAYPAL_PAYMENT_TOKEN_ID is held by another user; vault a different sandbox buyer',
    );
    process.exit(1);
  }
  await db.transaction(async (tx) => {
    await tx
      .update(vaultTokens)
      .set({ status: 'deleted', deletedAt: new Date() })
      .where(
        and(
          eq(vaultTokens.userId, userId),
          eq(vaultTokens.status, 'active'),
          ne(vaultTokens.paymentTokenId, tokenId),
        ),
      );
    await tx
      .insert(vaultTokens)
      .values({ userId, paypalCustomerId: customerId, paymentTokenId: tokenId, status: 'active' })
      .onConflictDoUpdate({
        target: [vaultTokens.userId, vaultTokens.paymentTokenId],
        set: { paypalCustomerId: customerId, status: 'active', deletedAt: null },
      });
  });
  return 'active (own token)';
}

/** A fresh signed card each run; the previous one is revoked. */
async function seedHijackCard(db: Db, userId: string): Promise<string> {
  const { RULE_HMAC_KEY, RULE_HMAC_KEY_ID } = env;
  if (!RULE_HMAC_KEY || !RULE_HMAC_KEY_ID) return 'not signed (RULE_HMAC_KEY missing)';
  const stores = await db
    .select({ id: merchants.id, slug: merchants.slug })
    .from(merchants)
    .where(inArray(merchants.slug, HIJACK_STORES));
  if (stores.length !== HIJACK_STORES.length) {
    console.error('hijack rules need the demo merchants: run npm run db:seed first');
    process.exit(1);
  }
  const [last] = await db
    .select({ v: raw<number>`coalesce(max(${ruleCards.version}), 0)::int` })
    .from(ruleCards)
    .where(eq(ruleCards.userId, userId));
  const version = (last?.v ?? 0) + 1;
  const signedAt = new Date();
  const expiresAt = new Date(signedAt.getTime() + HIJACK_CARD_DAYS * 24 * 60 * 60 * 1000);
  const card = RuleCardSchema.parse({
    version,
    userId,
    currency: 'USD',
    perItemCapCents: 7000,
    perOrderCapCents: 7000,
    allowedMerchantIds: HIJACK_STORES.map((slug) => stores.find((s) => s.slug === slug)?.id),
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
  await db.transaction(async (tx) => {
    await tx
      .update(ruleCards)
      .set({ status: 'revoked' })
      .where(and(eq(ruleCards.userId, userId), eq(ruleCards.status, 'signed')));
    await tx.insert(ruleCards).values({
      userId,
      version,
      status: 'signed',
      nlRequest:
        'Hijack box: running shoes under $70 from Stride Supply, Peak Outfitters or Pacer Goods, one item.',
      rules: signed.card,
      enforcement: {},
      signedAt,
      expiresAt,
      hmac: signed.sig,
      keyId: signed.keyId,
    });
  });
  return `signed v${version}, expires ${expiresAt.toISOString().slice(0, 10)}`;
}
