import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeed } from '../seed/seed.js';
import {
  budgetLedger,
  createDb,
  listings,
  merchants,
  remaining,
  ruleCards,
  spend,
  users,
} from '../src/index.js';
import { createTestDatabase, testDatabaseUrl } from '../src/testing.js';

const baseUrl = testDatabaseUrl();

describe.skipIf(!baseUrl)('db', () => {
  let testUrl = '';
  let drop = async () => {};

  beforeAll(async () => {
    ({ url: testUrl, drop } = await createTestDatabase(baseUrl as string));
  });

  afterAll(async () => {
    await drop();
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

  it('spend() adds atomically, records free calls, and trips at the cap', async () => {
    const { db, sql } = createDb(testUrl);
    try {
      await spend(db, 'live', 0, 1);
      await Promise.all([spend(db, 'live', 0.4, 1), spend(db, 'live', 0.4, 1)]);
      expect(await remaining(db, 'live', 1)).toBeCloseTo(0.2, 6);
      await expect(spend(db, 'live', 0.3, 1)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
      expect(await remaining(db, 'live', 1)).toBeCloseTo(0.2, 6);
      const [row] = await db.select().from(budgetLedger).where(eq(budgetLedger.scope, 'live'));
      expect(row?.trippedAt).not.toBeNull();
      await expect(spend(db, 'eval', 5, 1)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    } finally {
      await sql.end();
    }
  });
});
