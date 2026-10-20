/**
 * Live tenancy and assertion checks against a RUNNING local gateway:
 *
 *   npm run dev          (gateway on :4000)
 *   npm run e2e:tenancy
 *
 * Mints assertions the way web does (lib/human-assertion.ts) with the LOCAL web private key
 * from .env.web, inserts a draft rule card for maya and prints one row per check. Prints only
 * status and error codes: never tokens, assertions or keys. Local database only.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createDb, merchants, ruleCards, users } from '@twokey/db';
import { eq, inArray, max } from 'drizzle-orm';
import { importPKCS8, SignJWT } from 'jose';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:4000';
const DAY_MS = 24 * 60 * 60 * 1000;

const read = (name: string) =>
  parseEnv(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
const privatePem = read('.env.web').HUMAN_ASSERTION_PRIVATE_KEY;
const databaseUrl = read('.env.gateway').DATABASE_URL;
if (!privatePem || !databaseUrl) {
  console.error('needs HUMAN_ASSERTION_PRIVATE_KEY in .env.web and DATABASE_URL in .env.gateway');
  process.exit(1);
}
const dbHost = new URL(databaseUrl).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(dbHost)) {
  console.error(`e2e:tenancy only runs against a local database (host is ${dbHost})`);
  process.exit(1);
}

const key = await importPKCS8(privatePem, 'EdDSA');
type Who = { id: string; role: string };

async function mint(who: Who, scope: string[], opts: { expired?: boolean } = {}) {
  const now = Math.floor(Date.now() / 1000) - (opts.expired ? 600 : 0);
  return new SignJWT({ role: who.role, scope: scope.join(' ') })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('twokey-web')
    .setAudience('twokey-gateway')
    .setSubject(who.id)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(key);
}

async function call(method: string, path: string, assertion: string, body?: unknown) {
  const res = await fetch(new URL(path, GATEWAY), {
    method,
    headers: {
      authorization: `Bearer ${assertion}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: { code?: string };
    fingerprint?: unknown;
  };
  return { status: res.status, code: json.error?.code, json };
}

const { db, sql } = createDb(databaseUrl);
const rows: [string, string, string, boolean][] = [];
const check = (name: string, expected: string, actual: string) =>
  rows.push([name, expected, actual, expected === actual]);
const show = (r: { status: number; code?: string | undefined }) =>
  r.code ? `${r.status} ${r.code}` : String(r.status);

try {
  const people = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(inArray(users.email, ['maya@twokey.demo', 'judge1@twokey.demo']));
  const maya = people.find((p) => p.email === 'maya@twokey.demo');
  const judge = people.find((p) => p.email === 'judge1@twokey.demo');
  if (!maya || !judge) throw new Error('run npm run db:seed-users first');

  const stores = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(inArray(merchants.slug, ['stride-supply', 'peak-outfitters', 'pacer-goods']));
  const [top] = await db
    .select({ v: max(ruleCards.version) })
    .from(ruleCards)
    .where(eq(ruleCards.userId, maya.id));
  const [draft] = await db
    .insert(ruleCards)
    .values({
      userId: maya.id,
      version: (top?.v ?? 0) + 1,
      status: 'draft',
      nlRequest: 'Running shoes, size 10, under $70, only Stride Supply or Peak Outfitters',
      rules: {
        currency: 'USD',
        perItemCapCents: 7000,
        perOrderCapCents: 7000,
        allowedMerchantIds: stores.map((s) => s.id),
        maxQtyPerOrder: 1,
        frequency: { maxPurchases: 5, windowHours: 24 },
        holdTimeoutMinutes: 15,
        anomaly: { priceRatioThreshold: 1.3 },
        expiresAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
        advisory: [{ key: 'size', value: '10', label: 'Size' }],
      },
      enforcement: {},
    })
    .returning({ id: ruleCards.id });
  if (!draft) throw new Error('draft insert failed');
  const signPath = `/human/rules/${draft.id}/sign`;

  // a. another user's draft is a 404, never a 403
  check(
    'a. judge1 signs maya draft',
    '404 NOT_FOUND',
    show(await call('POST', signPath, await mint(judge, ['rules:sign']))),
  );

  // b. the owner signs it
  const ownerAssertion = await mint(maya, ['rules:sign']);
  const b = await call('POST', signPath, ownerAssertion);
  const fp = typeof b.json.fingerprint === 'string' && b.json.fingerprint.length > 0;
  check('b. maya signs own draft', '200 +fingerprint', `${show(b)}${fp ? ' +fingerprint' : ''}`);

  // c. judge_demo may not delete the wallet
  check(
    'c. judge1 DELETE /human/vault',
    '403 FORBIDDEN',
    show(await call('DELETE', '/human/vault', await mint(judge, ['vault:manage']))),
  );

  // d. wrong scope
  check(
    'd. maya events:read -> sessions',
    '403 FORBIDDEN',
    show(
      await call('POST', '/human/sessions', await mint(maya, ['events:read']), {
        mode: 'demo',
        model: 'test',
      }),
    ),
  );

  // e. the exact assertion from (b) again
  check(
    'e. replay assertion from (b)',
    '401 UNAUTHENTICATED',
    show(await call('GET', '/human/me', ownerAssertion)),
  );

  // f. exp in the past
  check(
    'f. expired assertion',
    '401 UNAUTHENTICATED',
    show(await call('GET', '/human/me', await mint(maya, [], { expired: true }))),
  );
} finally {
  await sql.end();
}

const header: [string, string, string, string] = ['check', 'expected', 'actual', 'result'];
const table = [header, ...rows.map(([c, e, a, ok]) => [c, e, a, ok ? 'PASS' : 'FAIL'])];
const widths = header.map((_, i) => Math.max(...table.map((r) => (r[i] ?? '').length)));
const line = (r: string[]) => r.map((v, i) => v.padEnd(widths[i] ?? 0)).join(' | ');
console.log(line(header));
console.log(widths.map((w) => '-'.repeat(w)).join('-|-'));
for (const r of table.slice(1)) console.log(line(r));
const failed = rows.filter((r) => !r[3]).length;
console.log(failed ? `\n${failed} FAILED` : `\nall ${rows.length} passed`);
process.exit(failed ? 1 : 0);
