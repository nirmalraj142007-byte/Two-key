import { AppError, ErrorCode, type Listing } from '@twokey/core';
import { catalogSnapshots, type Db, listings, merchants } from '@twokey/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AgentSession } from '../auth/agent-token.js';

export type ListingRow = typeof listings.$inferSelect;
export type MerchantRow = typeof merchants.$inferSelect;
type SnapshotKind = (typeof catalogSnapshots.$inferSelect)['kind'];

export interface ResolvedListing {
  listing: ListingRow;
  merchant: MerchantRow;
  /** What the gate evaluates: price, payee and references all come from our own rows. */
  gateListing: Listing;
}

/** Which catalog snapshots a session may buy from. */
export const SNAPSHOT_KINDS: Record<AgentSession['mode'], SnapshotKind[]> = {
  demo: ['demo_unbranded', 'hijack'],
  hijack: ['demo_unbranded', 'hijack'],
  eval: ['eval_frozen'],
  live: ['live_cache'],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the agent's product_id to a listing and its registry merchant. Everything the gate
 * and PayPal see (amount, payee) is read here; nothing comes from the agent.
 */
export async function resolveListing(
  db: Db,
  productId: string,
  session: Pick<AgentSession, 'mode'>,
): Promise<ResolvedListing> {
  const unknown = new AppError(ErrorCode.NOT_FOUND, 'Unknown product');
  if (!UUID.test(productId)) throw unknown;

  const [row] = await db
    .select({ listing: listings, merchant: merchants })
    .from(listings)
    .innerJoin(catalogSnapshots, eq(catalogSnapshots.id, listings.snapshotId))
    .innerJoin(merchants, eq(merchants.id, listings.merchantId))
    .where(
      and(eq(listings.id, productId), inArray(catalogSnapshots.kind, SNAPSHOT_KINDS[session.mode])),
    )
    .limit(1);
  if (!row) throw unknown;
  const { listing, merchant } = row;

  // Single-offer listings have no product reference price; the category median stands in.
  const [median] = await db
    .select({
      cents: sql<
        number | null
      >`round(percentile_cont(0.5) within group (order by ${listings.priceCents}))::int`,
    })
    .from(listings)
    .where(
      and(eq(listings.snapshotId, listing.snapshotId), eq(listings.category, listing.category)),
    );
  const categoryMedianCents = median?.cents && median.cents > 0 ? median.cents : null;

  return {
    listing,
    merchant,
    gateListing: {
      id: listing.id,
      merchantId: merchant.id,
      priceCents: listing.priceCents,
      category: listing.category,
      referencePriceCents: listing.referencePriceCents,
      referenceOffers: listing.referenceNOffers,
      categoryMedianCents,
    },
  };
}

const IGNORED_SEARCH_WORDS = new Set(['size', 'under', 'over']);

/** Query words that count for demo search: 3+ letters or digits, not size/under/over, deduped. */
export function searchWords(q: string): string[] {
  const words = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !IGNORED_SEARCH_WORDS.has(w));
  return [...new Set(words)];
}
