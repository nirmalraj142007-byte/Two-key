import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppError, ErrorCode } from '@twokey/core';
import { and, count, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { createDb } from '../src/client.js';
import { catalogSnapshots, listings, merchants } from '../src/schema/index.js';

const MerchantConfig = z.array(
  z.object({
    slug: z.string().min(1),
    displayName: z.string().min(1),
    paypalMerchantId: z.string().min(1).optional(),
    role: z.enum(['allowed_demo', 'attacker', 'eval_merchant']),
  }),
);

const CatalogEntry = z.object({
  group_key: z.string().min(1),
  merchant: z.string().min(1),
  title: z.string().min(1),
  brand_name: z.string().nullable(),
  category: z.string().min(1),
  price_cents: z.number().int().nonnegative(),
  description: z.string().min(1),
  structured_attrs: z.record(z.string(), z.unknown()).default({}),
});

const MERCHANTS_PATH = fileURLToPath(new URL('../../../config/merchants.json', import.meta.url));
const CATALOG_PATH = fileURLToPath(new URL('./demo-catalog.json', import.meta.url));

/** The anomaly rule needs a reference built from at least this many offers. */
const MIN_REFERENCE_OFFERS = 3;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return hi;
  return Math.round(((sorted[mid - 1] ?? hi) + hi) / 2);
}

export interface SeedResult {
  merchants: number;
  listings: number;
  snapshots: number;
}

export async function runSeed(url: string): Promise<SeedResult> {
  const merchantConfig = MerchantConfig.parse(JSON.parse(readFileSync(MERCHANTS_PATH, 'utf8')));
  for (const m of merchantConfig) {
    if (m.role !== 'eval_merchant' && !m.paypalMerchantId) {
      throw new AppError(
        ErrorCode.CONFIG_INVALID,
        `Merchant "${m.slug}" in config/merchants.json has no paypalMerchantId`,
      );
    }
  }

  const catalogRaw = readFileSync(CATALOG_PATH);
  const catalog = z.array(CatalogEntry).parse(JSON.parse(catalogRaw.toString('utf8')));
  const sha256 = createHash('sha256').update(catalogRaw).digest('hex');

  const { db, sql } = createDb(url);
  try {
    return await db.transaction(async (tx) => {
      for (const m of merchantConfig) {
        await tx
          .insert(merchants)
          .values({
            slug: m.slug,
            displayName: m.displayName,
            paypalMerchantId: m.paypalMerchantId ?? null,
            role: m.role,
          })
          .onConflictDoUpdate({
            target: merchants.slug,
            set: {
              displayName: m.displayName,
              paypalMerchantId: m.paypalMerchantId ?? null,
              role: m.role,
            },
          });
      }
      const merchantRows = await tx
        .select({ id: merchants.id, slug: merchants.slug })
        .from(merchants);
      const merchantIds = new Map(merchantRows.map((r) => [r.slug, r.id]));

      // catalog_snapshots' unique(kind, git_tag) never fires for a null tag, so look it up by hand.
      const [existing] = await tx
        .select({ id: catalogSnapshots.id })
        .from(catalogSnapshots)
        .where(and(eq(catalogSnapshots.kind, 'demo_unbranded'), isNull(catalogSnapshots.gitTag)));
      let snapshotId: string;
      if (existing) {
        snapshotId = existing.id;
        await tx
          .update(catalogSnapshots)
          .set({ contentSha256: sha256 })
          .where(eq(catalogSnapshots.id, snapshotId));
      } else {
        const [created] = await tx
          .insert(catalogSnapshots)
          .values({ kind: 'demo_unbranded', contentSha256: sha256 })
          .returning({ id: catalogSnapshots.id });
        if (!created) throw new AppError(ErrorCode.INTERNAL, 'Snapshot insert returned no row');
        snapshotId = created.id;
      }

      for (const entry of catalog) {
        const merchantId = merchantIds.get(entry.merchant);
        if (!merchantId) {
          throw new AppError(
            ErrorCode.CONFIG_INVALID,
            `Catalog entry in group "${entry.group_key}" names unknown merchant "${entry.merchant}"`,
          );
        }
        const values = {
          snapshotId,
          groupKey: entry.group_key,
          merchantId,
          title: entry.title,
          brandName: entry.brand_name,
          category: entry.category,
          priceCents: entry.price_cents,
          description: entry.description,
          structuredAttrs: entry.structured_attrs,
        };
        await tx
          .insert(listings)
          .values(values)
          .onConflictDoUpdate({
            target: [listings.snapshotId, listings.groupKey, listings.merchantId],
            set: {
              title: values.title,
              brandName: values.brandName,
              category: values.category,
              priceCents: values.priceCents,
              description: values.description,
              structuredAttrs: values.structuredAttrs,
            },
          });
      }

      const groups = new Map<string, number[]>();
      for (const entry of catalog) {
        groups.set(entry.group_key, [...(groups.get(entry.group_key) ?? []), entry.price_cents]);
      }
      for (const [groupKey, prices] of groups) {
        await tx
          .update(listings)
          .set({
            referencePriceCents: prices.length >= MIN_REFERENCE_OFFERS ? median(prices) : null,
            referenceNOffers: prices.length,
          })
          .where(and(eq(listings.snapshotId, snapshotId), eq(listings.groupKey, groupKey)));
      }

      const [m] = await tx.select({ n: count() }).from(merchants);
      const [l] = await tx.select({ n: count() }).from(listings);
      const [s] = await tx.select({ n: count() }).from(catalogSnapshots);
      return { merchants: m?.n ?? 0, listings: l?.n ?? 0, snapshots: s?.n ?? 0 };
    });
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write('DATABASE_URL is not set\n');
    process.exit(1);
  }
  try {
    const r = await runSeed(url);
    process.stdout.write(
      `merchants: ${r.merchants}, listings: ${r.listings}, snapshots: ${r.snapshots}\n`,
    );
  } catch (err) {
    process.stderr.write(`seed failed: ${err instanceof Error ? err.message : 'unknown error'}\n`);
    process.exit(1);
  }
}
