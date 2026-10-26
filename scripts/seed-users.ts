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
 */
import { hash } from '@node-rs/argon2';
import { createDb, users } from '@twokey/db';
import { sql as raw } from 'drizzle-orm';
import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  DEMO_PASSWORD: z.string().min(8, 'DEMO_PASSWORD must be at least 8 characters'),
});

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
} finally {
  await sql.end();
}
