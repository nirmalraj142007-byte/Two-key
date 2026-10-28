/**
 * Vaults a PayPal wallet for the hijack system user (phase 22), with the vault spike's flow:
 *
 *   npm run vault:hijack
 *   npm run vault:hijack -- --setup-token <id>   (an earlier link approved after the run ended)
 *
 * Creates a setup token, prints the approval link, waits for the sandbox buyer to approve, turns
 * it into a payment token and writes HIJACK_PAYPAL_PAYMENT_TOKEN_ID and HIJACK_PAYPAL_CUSTOMER_ID
 * into .env.gateway. The IDs are never printed. A payment token that another user already holds
 * is refused (PayPal hands the same token back for a buyer it has vaulted before): approve with
 * a sandbox buyer no other account uses. Then run `npm run db:seed-users`.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDb, users, vaultTokens } from '@twokey/db';
import { and, eq, ne } from 'drizzle-orm';
import { describeError, ROOT, setupPayPal } from './lib.js';

const POLL_MS = 3_000;
const POLL_LIMIT_MS = 30 * 60_000;
const ENV_FILE = resolve(ROOT, '.env.gateway');
const HIJACK_EMAIL = 'hijack@twokey.system';

/** Sets KEY=value in an env file, replacing an existing line or appending one. */
function setEnvLines(text: string, values: Record<string, string>): string {
  let out = text.endsWith('\n') || text === '' ? text : `${text}\n`;
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    out = re.test(out) ? out.replace(re, line) : `${out}${line}\n`;
  }
  return out;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL missing from .env.gateway');
  const pp = setupPayPal();
  const runId = randomBytes(4).toString('hex');

  // --setup-token <id> picks up a link approved after an earlier run stopped waiting.
  const at = process.argv.indexOf('--setup-token');
  const resumed = at === -1 ? undefined : process.argv[at + 1];
  const st = resumed
    ? { id: resumed }
    : await pp.createSetupToken({
        returnUrl: 'http://localhost:3000/spike/return',
        cancelUrl: 'http://localhost:3000/spike/cancel',
        requestId: `tk-hijack-vault-${runId}-setup-token`,
      });
  if (!resumed && 'approveUrl' in st) {
    console.log('Open this link, log in as a sandbox BUYER that no other Two-Key account uses,');
    console.log('and approve. The page you land on afterwards may not load; that is fine.');
    console.log(`  ${st.approveUrl}`);
  }

  const deadline = Date.now() + POLL_LIMIT_MS;
  let status = '';
  while (Date.now() < deadline) {
    try {
      const next = (await pp.getSetupToken(st.id)).status;
      if (next !== status) console.log(`status: ${next}`);
      status = next;
      if (status === 'APPROVED') break;
    } catch (err) {
      console.log(`poll error: ${describeError(err)}`);
    }
    await sleep(POLL_MS);
  }
  if (status !== 'APPROVED') throw new Error('not approved within 30 minutes; run again');

  const pt = await pp.createPaymentToken({
    setupTokenId: st.id,
    requestId: `tk-hijack-vault-${runId}-payment-token`,
  });
  if (!pt.customerId) throw new Error('PayPal returned no customer ID');

  const { db, sql } = createDb(databaseUrl);
  try {
    const [hijack] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, HIJACK_EMAIL));
    const [shared] = await db
      .select({ id: vaultTokens.id })
      .from(vaultTokens)
      .where(
        and(
          eq(vaultTokens.paymentTokenId, pt.paymentTokenId),
          hijack ? ne(vaultTokens.userId, hijack.id) : undefined,
        ),
      )
      .limit(1);
    if (shared) {
      console.error('REFUSED: PayPal returned a payment token another Two-Key user already holds.');
      console.error('Approve again with a different sandbox buyer account. Nothing was written.');
      process.exitCode = 1;
      return;
    }
  } finally {
    await sql.end();
  }

  writeFileSync(
    ENV_FILE,
    setEnvLines(readFileSync(ENV_FILE, 'utf8'), {
      HIJACK_PAYPAL_PAYMENT_TOKEN_ID: pt.paymentTokenId,
      HIJACK_PAYPAL_CUSTOMER_ID: pt.customerId,
    }),
  );
  console.log(
    'Saved the hijack wallet to .env.gateway (IDs not shown). Next: npm run db:seed-users',
  );
}

main().catch((err) => {
  console.error(describeError(err));
  process.exit(1);
});
