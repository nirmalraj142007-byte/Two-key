/**
 * Shared by demo:setup and demo:reset: which environment to act on, the demo accounts, and the
 * preset demo rules card.
 *
 * --env local  reads .env.gateway and refuses a non-local database.
 * --env prod   reads ~/two-key-secrets/prod-gateway.env (or --env-file <path>) and refuses a
 *              local database; DEMO_PASSWORD falls back to ~/two-key-secrets/demo-password.txt.
 * no --env     only on Render (the twokey-demo-reset cron job), where the variables are set.
 * Variables already in the shell win over the file. No secret value is ever printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type CompilerOutput,
  type RuleCard,
  RuleCardSchema,
  toDraftCard,
  verifyCard,
} from '@twokey/core';
import { type Db, listings, merchants, ruleCards, users, vaultTokens } from '@twokey/db';
import { signDraftCard } from '@twokey/gateway';
import { and, desc, eq, gt, inArray, max, ne } from 'drizzle-orm';

/** `hosted`: a Render cron job or the GitHub Actions demo-reset workflow; secrets come from the environment. */
export type DemoEnv = 'local' | 'prod' | 'hosted';

export const DEMO_REQUEST =
  'Running shoes, size 10, under $70, only Stride Supply or Peak Outfitters, one pair, this week.';

/** The accounts demo:setup creates and demo:reset cleans. Never chosen by role alone. */
export const DEMO_ACCOUNTS = [
  { email: 'maya@twokey.demo', displayName: 'Maya', role: 'user' },
  { email: 'judge1@twokey.demo', displayName: 'Judge 1', role: 'judge_demo' },
  { email: 'judge2@twokey.demo', displayName: 'Judge 2', role: 'judge_demo' },
  { email: 'judge3@twokey.demo', displayName: 'Judge 3', role: 'judge_demo' },
] as const;
export const DEMO_EMAILS: string[] = DEMO_ACCOUNTS.map((a) => a.email);

/**
 * "maya,judge1" (or full emails) → demo emails, in DEMO_ACCOUNTS order, without duplicates.
 * Throws on a name that isn't a demo account.
 */
export function parseDemoAccounts(list: string): string[] {
  const wanted = new Set<string>();
  for (const raw of list.split(',')) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    const email = name.includes('@') ? name : `${name}@twokey.demo`;
    if (!DEMO_EMAILS.includes(email)) {
      throw new Error(`${raw.trim()} is not a demo account (maya, judge1, judge2, judge3)`);
    }
    wanted.add(email);
  }
  if (wanted.size === 0) throw new Error('no accounts listed');
  return DEMO_EMAILS.filter((e) => wanted.has(e));
}
export const HIJACK_EMAIL = 'hijack@twokey.system';

const SECRETS_DIR = join(homedir(), 'two-key-secrets');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export const CARD_DAYS = 60;
/** A card expiring sooner than this is re-signed by demo:reset. */
export const RESIGN_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

export function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

/** Loads the environment for --env and checks the database is the one that was meant. */
export function loadDemoEnv(argv: string[], script: string): DemoEnv {
  const asked = flag(argv, '--env');
  let env: DemoEnv;
  if (asked === 'local' || asked === 'prod') env = asked;
  else if (asked === undefined && (process.env.RENDER || process.env.GITHUB_ACTIONS === 'true')) {
    env = 'hosted';
  } else {
    console.error(`usage: npm run ${script} -- --env local|prod`);
    process.exit(1);
  }
  const root = join(import.meta.dirname, '..');
  const file =
    env === 'local'
      ? join(root, '.env.gateway')
      : env === 'prod'
        ? (flag(argv, '--env-file') ?? join(SECRETS_DIR, 'prod-gateway.env'))
        : undefined;
  if (file) {
    if (!existsSync(file)) {
      console.error(`${script}: ${file} not found`);
      process.exit(1);
    }
    process.loadEnvFile(file);
  }
  const passwordFile = join(SECRETS_DIR, 'demo-password.txt');
  if (env === 'prod' && !process.env.DEMO_PASSWORD && existsSync(passwordFile)) {
    process.env.DEMO_PASSWORD = readFileSync(passwordFile, 'utf8').trim();
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(`${script} needs DATABASE_URL`);
    process.exit(1);
  }
  const local = LOCAL_HOSTS.has(new URL(url).hostname);
  if (env === 'local' && !local) {
    console.error(`${script} --env local refuses a non-local database`);
    process.exit(1);
  }
  if (env !== 'local' && local) {
    console.error(`${script} --env ${env} refuses a local database`);
    process.exit(1);
  }
  return env;
}

export function requireVars<K extends string>(script: string, keys: K[]): Record<K, string> {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`${script} needs ${missing.join(', ')}`);
    process.exit(1);
  }
  return Object.fromEntries(keys.map((k) => [k, process.env[k] as string])) as Record<K, string>;
}

export async function demoUsers(db: Db) {
  return db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(inArray(users.email, DEMO_EMAILS));
}

export async function hasActiveVault(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: vaultTokens.id })
    .from(vaultTokens)
    .where(and(eq(vaultTokens.userId, userId), eq(vaultTokens.status, 'active')))
    .limit(1);
  return row !== undefined;
}

/** The user's signed, unexpired card, newest version first. */
export async function activeCard(db: Db, userId: string, now: Date) {
  const [row] = await db
    .select({ id: ruleCards.id, version: ruleCards.version, expiresAt: ruleCards.expiresAt })
    .from(ruleCards)
    .where(
      and(
        eq(ruleCards.userId, userId),
        eq(ruleCards.status, 'signed'),
        gt(ruleCards.expiresAt, now),
      ),
    )
    .orderBy(desc(ruleCards.version))
    .limit(1);
  return row;
}

/**
 * The preset demo card: Stride Supply and Peak Outfitters; $70 caps; one item; 5 purchases per
 * 24 h; 15-minute holds; "size 10" advisory; expires in 60 days. Built by the same deterministic
 * toDraftCard the rule compiler uses, stored as a draft, then signed by the gateway's signer.
 */
export async function signDemoCard(
  db: Db,
  userId: string,
  key: { id: string; secret: Buffer },
  now: Date,
): Promise<{ version: number; expiresAt: Date }> {
  const rows = await db
    .select({
      id: merchants.id,
      slug: merchants.slug,
      displayName: merchants.displayName,
      category: listings.category,
    })
    .from(merchants)
    .leftJoin(listings, eq(listings.merchantId, merchants.id))
    .where(eq(merchants.role, 'allowed_demo'));
  const registry = new Map<
    string,
    { id: string; slug: string; displayName: string; categories: string[] }
  >();
  for (const r of rows) {
    const e = registry.get(r.id) ?? {
      id: r.id,
      slug: r.slug,
      displayName: r.displayName,
      categories: [],
    };
    if (r.category && !e.categories.includes(r.category)) e.categories.push(r.category);
    registry.set(r.id, e);
  }
  const output: CompilerOutput = {
    perItemCapUsd: 70,
    perOrderCapUsd: 70,
    stores: ['Stride Supply', 'Peak Outfitters'],
    categories: null,
    maxQty: 1,
    frequency: { maxPurchases: 5, windowHours: 24 },
    expiresInDays: CARD_DAYS,
    advisory: [{ key: 'size', value: '10', label: 'Size' }],
    unclear: [],
  };
  const [prev] = await db
    .select({ v: max(ruleCards.version) })
    .from(ruleCards)
    .where(eq(ruleCards.userId, userId));
  const version = (prev?.v ?? 0) + 1;
  const draft = toDraftCard(output, {
    userId,
    registry: [...registry.values()],
    now,
    version,
    defaults: {
      frequency: { maxPurchases: 5, windowHours: 24 },
      holdTimeoutMinutes: 15,
      expiresInDays: CARD_DAYS,
    },
  });
  const card: RuleCard | null = draft.card;
  if (!card || draft.warnings.length > 0) {
    throw new Error(
      `demo card did not compile: ${[...draft.needsInput, ...draft.warnings].join('; ')} (run db:seed)`,
    );
  }
  const [row] = await db
    .insert(ruleCards)
    .values({
      userId,
      version,
      status: 'draft',
      nlRequest: DEMO_REQUEST,
      rules: card,
      enforcement: draft.enforcement,
      compilerModel: null,
    })
    .returning({ id: ruleCards.id });
  if (!row) throw new Error('demo card draft insert returned no row');
  await signDraftCard(db, {
    userId,
    draftId: row.id,
    signingKeyId: key.id,
    signingSecret: key.secret,
    now,
  });
  return { version, expiresAt: new Date(card.expiresAt) };
}

export function ruleKey(): { id: string; secret: Buffer } {
  const { RULE_HMAC_KEY, RULE_HMAC_KEY_ID } = process.env;
  if (!RULE_HMAC_KEY || !RULE_HMAC_KEY_ID) throw new Error('RULE_HMAC_KEY is not set');
  return { id: RULE_HMAC_KEY_ID, secret: Buffer.from(RULE_HMAC_KEY, 'base64') };
}

export const day = (d: Date) => d.toISOString().slice(0, 10);

// ---- hijack system user (phase 22) --------------------------------------------------------------

const HIJACK_STORES = ['stride-supply', 'peak-outfitters', 'pacer-goods'];
export const HIJACK_NL =
  'Hijack box: running shoes under $70 from Stride Supply, Peak Outfitters or Pacer Goods, one item.';

/**
 * The hijack user's own wallet from HIJACK_PAYPAL_PAYMENT_TOKEN_ID / HIJACK_PAYPAL_CUSTOMER_ID
 * (made once by `npm run vault:hijack`). A token another user holds is refused: payment tokens
 * are never shared with the hijack user. The IDs are never printed.
 */
export async function ensureHijackVault(
  db: Db,
  userId: string,
  ids: { tokenId?: string | undefined; customerId?: string | undefined },
): Promise<string> {
  const { tokenId, customerId } = ids;
  if (!tokenId || !customerId) {
    return (await hasActiveVault(db, userId))
      ? 'active'
      : 'missing (run npm run vault:hijack, set HIJACK_PAYPAL_*, run this again)';
  }
  const [other] = await db
    .select({ id: vaultTokens.id })
    .from(vaultTokens)
    .where(and(eq(vaultTokens.paymentTokenId, tokenId), ne(vaultTokens.userId, userId)))
    .limit(1);
  if (other) {
    throw new Error(
      'HIJACK_PAYPAL_PAYMENT_TOKEN_ID is held by another user; vault a different sandbox buyer',
    );
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

/**
 * A fresh hijack card: Stride Supply, Peak Outfitters, Pacer Goods; $70 caps; one item; 50
 * purchases per 24 h; 15-minute holds; 60 days. Signed by the gateway's signer.
 */
export async function signHijackCard(
  db: Db,
  userId: string,
  key: { id: string; secret: Buffer },
  now: Date,
): Promise<{ version: number; expiresAt: Date }> {
  const stores = await db
    .select({ id: merchants.id, slug: merchants.slug })
    .from(merchants)
    .where(inArray(merchants.slug, HIJACK_STORES));
  if (stores.length !== HIJACK_STORES.length) {
    throw new Error('hijack rules need the demo merchants: run npm run db:seed first');
  }
  const [prev] = await db
    .select({ v: max(ruleCards.version) })
    .from(ruleCards)
    .where(eq(ruleCards.userId, userId));
  const version = (prev?.v ?? 0) + 1;
  const expiresAt = new Date(now.getTime() + CARD_DAYS * 24 * 60 * 60 * 1000);
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
  const [row] = await db
    .insert(ruleCards)
    .values({
      userId,
      version,
      status: 'draft',
      nlRequest: HIJACK_NL,
      rules: card,
      enforcement: {},
    })
    .returning({ id: ruleCards.id });
  if (!row) throw new Error('hijack card draft insert returned no row');
  await signDraftCard(db, {
    userId,
    draftId: row.id,
    signingKeyId: key.id,
    signingSecret: key.secret,
    now,
  });
  return { version, expiresAt };
}

/** Whether the user's active card verifies with this key (so the gateway will accept it). */
export async function cardVerifies(
  db: Db,
  userId: string,
  key: { id: string; secret: Buffer },
  now: Date,
): Promise<boolean> {
  const active = await activeCard(db, userId, now);
  if (!active) return false;
  const [row] = await db
    .select({ rules: ruleCards.rules, hmac: ruleCards.hmac, keyId: ruleCards.keyId })
    .from(ruleCards)
    .where(eq(ruleCards.id, active.id));
  try {
    verifyCard(
      { card: row?.rules, keyId: row?.keyId, alg: 'HS256', sig: row?.hmac },
      { [key.id]: key.secret },
      now,
    );
    return true;
  } catch {
    return false;
  }
}
