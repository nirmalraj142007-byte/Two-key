import type { Registry } from '@twokey/core';
import { listings, merchants } from '@twokey/db';
import { eq } from 'drizzle-orm';
import { db } from './db';

/** Allowed stores and the categories they list. Listing text never leaves the database. */
export async function loadRegistry(): Promise<Registry> {
  const rows = await db()
    .select({
      id: merchants.id,
      slug: merchants.slug,
      displayName: merchants.displayName,
      category: listings.category,
    })
    .from(merchants)
    .leftJoin(listings, eq(listings.merchantId, merchants.id))
    .where(eq(merchants.role, 'allowed_demo'));
  const byId = new Map<string, Registry[number]>();
  for (const r of rows) {
    const entry = byId.get(r.id) ?? {
      id: r.id,
      slug: r.slug,
      displayName: r.displayName,
      categories: [],
    };
    if (r.category && !entry.categories.includes(r.category)) entry.categories.push(r.category);
    byId.set(r.id, entry);
  }
  return [...byId.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}
