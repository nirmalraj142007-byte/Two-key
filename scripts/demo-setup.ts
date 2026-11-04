/**
 * npm run demo:setup -- --env local|prod [--accounts maya,judge1]
 * The demo tenant, idempotently (docs/DEMO.md).
 *
 * --accounts limits steps 1–3 to the listed demo accounts; the others are reported as skipped and
 * left unchanged. Steps 0, 4 and 5 (catalog, demo hook, hijack user) always run.
 *
 * 0. Runs the idempotent catalog seed (merchants, demo catalog), as db:seed does.
 * 1. Upserts maya@twokey.demo (user) and judge1–3@twokey.demo (judge_demo) with DEMO_PASSWORD,
 *    and hijack@twokey.system (no password).
 * 2. Checks each demo account has its own active PayPal wallet. If any is missing it prints, per
 *    account, where to sign in and the onboarding page to approve once as the sandbox buyer, and
 *    stops (exit 2) before anything else changes. Run it again afterwards.
 * 3. Signs the preset demo card for each account (kept if one is active for 7+ more days).
 * 4. Rebuilds the demo hook listing from the recorded episode (demo:hook --pinned).
 * 5. Checks the hijack user's wallet and card (signing a fresh card if it has none) and that both
 *    cards verify with this RULE_HMAC_KEY (else the gateway would block every proposal).
 *
 * Runs with the gateway's secrets (see scripts/demo-lib.ts for --env). Never prints a secret.
 */
import { hash } from '@node-rs/argon2';
import { createDb, ruleCards, users } from '@twokey/db';
import { runSeed } from '@twokey/db/testing';
import { eq } from 'drizzle-orm';
import { buildDemoHook, hookSummary } from './demo-hook-lib.js';
import {
  activeCard,
  cardVerifies,
  DEMO_ACCOUNTS,
  DEMO_REQUEST,
  day,
  ensureHijackVault,
  flag,
  HIJACK_EMAIL,
  hasActiveVault,
  loadDemoEnv,
  parseDemoAccounts,
  RESIGN_WITHIN_MS,
  requireVars,
  ruleKey,
  signDemoCard,
  signHijackCard,
} from './demo-lib.js';

const SCRIPT = 'demo:setup';
const argv = process.argv.slice(2);
const accountsFlag = flag(argv, '--accounts');
let selected: Set<string>;
try {
  selected = new Set(
    accountsFlag === undefined
      ? DEMO_ACCOUNTS.map((a) => a.email)
      : parseDemoAccounts(accountsFlag),
  );
} catch (err) {
  console.error(`${SCRIPT}: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
const accounts = DEMO_ACCOUNTS.filter((a) => selected.has(a.email));
const skipped = DEMO_ACCOUNTS.filter((a) => !selected.has(a.email));
const envName = loadDemoEnv(argv, SCRIPT);
const env = requireVars(SCRIPT, [
  'DATABASE_URL',
  'DEMO_PASSWORD',
  'RULE_HMAC_KEY',
  'RULE_HMAC_KEY_ID',
  'WEB_ORIGIN',
]);
if (env.DEMO_PASSWORD.length < 8) {
  console.error('DEMO_PASSWORD must be at least 8 characters');
  process.exit(1);
}
const origin = new URL(env.WEB_ORIGIN).origin;
if (envName !== 'local' && !origin.startsWith('https://')) {
  console.error(`WEB_ORIGIN must be the public https site for --env ${envName}`);
  process.exit(1);
}

const { db, sql } = createDb(env.DATABASE_URL);
const now = new Date();
const key = ruleKey();
const pad = (s: string) => s.padEnd(22);

try {
  console.log(`demo:setup --env ${envName} (database ${new URL(env.DATABASE_URL).hostname})`);
  if (skipped.length > 0) {
    console.log(`accounts ${accounts.map((a) => a.email).join(', ')}`);
    for (const a of skipped) console.log(`skipped ${pad(a.email)} not in --accounts, unchanged`);
  }

  // 0. merchants and the demo catalog (idempotent upserts; db:seed does the same)
  const seeded = await runSeed(env.DATABASE_URL);
  console.log(`catalog ${JSON.stringify(seeded)}`);

  // 1. accounts
  const passwordHash = await hash(env.DEMO_PASSWORD);
  const ids = new Map<string, string>();
  for (const a of [
    ...accounts,
    { email: HIJACK_EMAIL, displayName: 'Hijack system', role: 'hijack_system' as const },
  ]) {
    const hashed = a.role === 'hijack_system' ? null : passwordHash;
    const [row] = await db
      .insert(users)
      .values({ ...a, passwordHash: hashed })
      .onConflictDoUpdate({
        target: users.email,
        set: { displayName: a.displayName, role: a.role, passwordHash: hashed },
      })
      .returning({ id: users.id });
    if (!row) throw new Error(`upsert of ${a.email} returned no row`);
    ids.set(a.email, row.id);
    console.log(
      `user    ${pad(a.email)} ${a.role.padEnd(13)} ${hashed ? 'password set' : 'no password'}`,
    );
  }
  const idOf = (email: string) => ids.get(email) as string;

  // 2. wallets
  const missing: string[] = [];
  for (const a of accounts) {
    const ok = await hasActiveVault(db, idOf(a.email));
    console.log(`vault   ${pad(a.email)} ${ok ? 'active' : 'MISSING'}`);
    if (!ok) missing.push(a.email);
  }
  if (missing.length > 0) {
    console.log('');
    console.log(
      `${missing.length} account(s) need their own saved PayPal wallet. For each, in a private window:`,
    );
    for (const email of missing) {
      console.log(`  - sign in at ${origin}/login as ${email} (DEMO_PASSWORD),`);
      console.log(
        `    open ${origin}/onboarding/paypal, click Connect PayPal, approve as the sandbox buyer.`,
      );
    }
    console.log('Then run demo:setup again. Nothing else was changed.');
    process.exitCode = 2;
  } else {
    // 3. demo cards
    for (const a of accounts) {
      const userId = idOf(a.email);
      const active = await activeCard(db, userId, now);
      let demo = false;
      if (active) {
        const [row] = await db
          .select({ nl: ruleCards.nlRequest })
          .from(ruleCards)
          .where(eq(ruleCards.id, active.id));
        demo = row?.nl === DEMO_REQUEST;
      }
      const fresh =
        active &&
        demo &&
        active.expiresAt !== null &&
        active.expiresAt.getTime() - now.getTime() > RESIGN_WITHIN_MS &&
        (await cardVerifies(db, userId, key, now));
      if (fresh && active) {
        console.log(
          `rules   ${pad(a.email)} kept v${active.version}, expires ${day(active.expiresAt as Date)}`,
        );
      } else {
        const s = await signDemoCard(db, userId, key, now);
        console.log(`rules   ${pad(a.email)} signed v${s.version}, expires ${day(s.expiresAt)}`);
      }
    }

    // 4. demo hook
    console.log(hookSummary(await buildDemoHook(sql, { pinned: true })));

    // 5. hijack user
    const hijackId = idOf(HIJACK_EMAIL);
    const vault = await ensureHijackVault(db, hijackId, {
      tokenId: process.env.HIJACK_PAYPAL_PAYMENT_TOKEN_ID,
      customerId: process.env.HIJACK_PAYPAL_CUSTOMER_ID,
    });
    console.log(`hijack  vault ${vault}`);
    const card = await activeCard(db, hijackId, now);
    if (
      card?.expiresAt &&
      card.expiresAt.getTime() - now.getTime() > RESIGN_WITHIN_MS &&
      (await cardVerifies(db, hijackId, key, now))
    ) {
      console.log(`hijack  rules kept v${card.version}, expires ${day(card.expiresAt)} (verified)`);
    } else {
      const s = await signHijackCard(db, hijackId, key, now);
      console.log(`hijack  rules signed v${s.version}, expires ${day(s.expiresAt)}`);
    }
    if (!(await cardVerifies(db, hijackId, key, now)))
      throw new Error('hijack card does not verify');
    if (!vault.startsWith('active')) process.exitCode = 2;
    if (process.exitCode) console.log('demo:setup incomplete (see above)');
    else if (skipped.length > 0) {
      console.log(`skipped ${skipped.map((a) => a.email).join(', ')} (not in --accounts)`);
      console.log(`demo:setup done for ${accounts.map((a) => a.email).join(', ')}`);
    } else console.log('demo:setup done');
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
