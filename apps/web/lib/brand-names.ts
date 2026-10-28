import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogSnapshots, type Db, listings } from '@twokey/db';
import { eq } from 'drizzle-orm';

/**
 * Every brand name in the evaluation snapshot: each listing's brand_name, plus every brand
 * Channel3 returned for those products when the local search cache is present (a product can
 * carry several brands; the listing keeps only the first).
 */
export async function loadBrandNames(db: Db, cacheDir = findCacheDir()): Promise<string[]> {
  const rows = await db
    .selectDistinct({ name: listings.brandName })
    .from(listings)
    .innerJoin(catalogSnapshots, eq(catalogSnapshots.id, listings.snapshotId))
    .where(eq(catalogSnapshots.kind, 'eval_frozen'));
  const names = new Set<string>();
  for (const r of rows) if (r.name?.trim()) names.add(r.name.trim());
  for (const name of cachedBrandNames(cacheDir)) names.add(name);
  return [...names].sort();
}

/** The git-ignored Channel3 cache (eval/data/channel3-cache), when this machine has it. */
function findCacheDir(): string | null {
  for (const base of [process.cwd(), join(process.cwd(), '..'), join(process.cwd(), '../..')]) {
    const dir = join(base, 'eval', 'data', 'channel3-cache');
    if (existsSync(dir)) return dir;
  }
  return null;
}

interface CachedProduct {
  brands?: { name?: unknown }[] | null;
}

function cachedBrandNames(dir: string | null): string[] {
  if (!dir) return [];
  const out: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const body = JSON.parse(readFileSync(join(dir, file), 'utf8')) as
        | CachedProduct[]
        | { products?: CachedProduct[]; results?: CachedProduct[] };
      const products = Array.isArray(body) ? body : (body.products ?? body.results ?? []);
      for (const p of products) {
        for (const b of p.brands ?? []) {
          if (typeof b.name === 'string' && b.name.trim()) out.push(b.name.trim());
        }
      }
    } catch {
      // An unreadable cache file adds no names; the snapshot's own brand names still apply.
    }
  }
  return out;
}
