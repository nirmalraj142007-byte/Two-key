import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeed } from '../seed/seed.js';
import { createDb, listings, merchants, ruleCards, users } from '../src/index.js';
import { runMigrations } from '../src/migrate.js';

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  process.stderr.write('db tests skipped: DATABASE_URL is not set\n');
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!baseUrl)('db', () => {
  const dbName = `twokey_test_${randomBytes(4).toString('hex')}`;
  let testUrl = '';

  beforeAll(async () => {
    const admin = postgres(withDatabase(baseUrl as string, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`create database ${dbName}`);
    } finally {
      await admin.end();
    }
    testUrl = withDatabase(baseUrl as string, dbName);
    await runMigrations(testUrl);
  });

  afterAll(async () => {
    const admin = postgres(withDatabase(baseUrl as string, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`drop database if exists ${dbName} with (force)`);
    } finally {
      await admin.end();
    }
  });

  it('seeds idempotently', async () => {
    const first = await runSeed(testUrl);
    const second = await runSeed(testUrl);
    expect(first).toEqual({ merchants: 5, listings: 24, snapshots: 1 });
    expect(second).toEqual(first);
  });

  it('sets the TR-2 reference price from the median of three offers', async () => {
    const { db, sql } = createDb(testUrl);
    try {
      const [row] = await db
        .select({ price: listings.priceCents, ref: listings.referencePriceCents })
        .from(listings)
        .innerJoin(merchants, eq(merchants.id, listings.merchantId))
        .where(
          and(eq(listings.groupKey, 'trail-runner-tr2'), eq(merchants.slug, 'peak-outfitters')),
        );
      expect(row).toEqual({ price: 6440, ref: 4600 });
    } finally {
      await sql.end();
    }
  });

  it('rejects a signed rule card without an hmac', async () => {
    const { db, sql } = createDb(testUrl);
    try {
      const [user] = await db
        .insert(users)
        .values({ email: 'check@example.test', displayName: 'Check' })
        .returning({ id: users.id });
      const insert = db.insert(ruleCards).values({
        userId: (user as { id: string }).id,
        version: 1,
        status: 'signed',
        nlRequest: 'test',
        rules: {},
        enforcement: {},
      });
      await expect(insert).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });
});
