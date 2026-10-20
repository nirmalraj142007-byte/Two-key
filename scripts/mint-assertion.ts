/**
 * Prints one 60-second human assertion, minted the way web does (apps/web/lib/human-assertion.ts),
 * for local curl checks against a running gateway:
 *
 *   npx tsx scripts/mint-assertion.ts e2e@twokey.demo approvals:decide [more scopes...]
 *
 * Reads HUMAN_ASSERTION_PRIVATE_KEY from .env.web and DATABASE_URL from .env.gateway (local
 * database only). Prints only the assertion, so `A=$(...)` captures it. Each one is accepted once.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createDb, users } from '@twokey/db';
import { eq } from 'drizzle-orm';
import { importPKCS8, SignJWT } from 'jose';

const SCOPES = new Set([
  'vault:manage',
  'rules:sign',
  'sessions:create',
  'approvals:decide',
  'events:read',
  'push:manage',
  'hijack:create',
]);

const [email, ...scopes] = process.argv.slice(2);
if (!email || scopes.length === 0 || scopes.some((s) => !SCOPES.has(s))) {
  console.error(
    `usage: npx tsx scripts/mint-assertion.ts <email> <scope...>\nscopes: ${[...SCOPES].join(' ')}`,
  );
  process.exit(1);
}

const read = (name: string) =>
  parseEnv(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
const privatePem = read('.env.web').HUMAN_ASSERTION_PRIVATE_KEY;
const databaseUrl = read('.env.gateway').DATABASE_URL;
if (!privatePem || !databaseUrl) {
  console.error('needs HUMAN_ASSERTION_PRIVATE_KEY in .env.web and DATABASE_URL in .env.gateway');
  process.exit(1);
}
const host = new URL(databaseUrl).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error(`mint-assertion only runs against a local database (host is ${host})`);
  process.exit(1);
}

const { db, sql } = createDb(databaseUrl);
try {
  const [user] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) {
    console.error(`no user ${email}`);
    process.exit(1);
  }
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ role: user.role, scope: scopes.join(' ') })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('twokey-web')
    .setAudience('twokey-gateway')
    .setSubject(user.id)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(await importPKCS8(privatePem, 'EdDSA'));
  process.stdout.write(`${jwt}\n`);
} finally {
  await sql.end();
}
