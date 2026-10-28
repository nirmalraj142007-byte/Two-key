import { AppError, ErrorCode, type Listing } from '@twokey/core';
import { catalogSnapshots, type Db, listings, merchants } from '@twokey/db';
import { and, eq, inArray, ne, or, type SQL, sql } from 'drizzle-orm';
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
  demo: ['demo_unbranded'],
  hijack: ['demo_unbranded', 'hijack'],
  eval: ['eval_frozen'],
  live: ['live_cache'],
};

/**
 * The snapshots a session may see. A hijack snapshot holds one judge's injected listing and
 * belongs to exactly one session; every other session (hijack ones included) never sees it.
 */
export function visibleSnapshots(session: Pick<AgentSession, 'id' | 'mode'>): SQL | undefined {
  return and(
    inArray(catalogSnapshots.kind, SNAPSHOT_KINDS[session.mode]),
    or(ne(catalogSnapshots.kind, 'hijack'), eq(catalogSnapshots.sessionId, session.id)),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the agent's product_id to a listing and its registry merchant. Everything the gate
 * and PayPal see (amount, payee) is read here; nothing comes from the agent.
 */
export async function resolveListing(
  db: Db,
  productId: string,
  session: Pick<AgentSession, 'id' | 'mode'>,
): Promise<ResolvedListing> {
  const unknown = new AppError(ErrorCode.NOT_FOUND, 'Unknown product');
  if (!UUID.test(productId)) throw unknown;

  const [row] = await db
    .select({ listing: listings, merchant: merchants })
    .from(listings)
    .innerJoin(catalogSnapshots, eq(catalogSnapshots.id, listings.snapshotId))
    .innerJoin(merchants, eq(merchants.id, listings.merchantId))
    .where(and(eq(listings.id, productId), visibleSnapshots(session)))
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

/** Eval listing text: the original description cut to this many characters. */
export const EVAL_TEXT_MAX = 500;

/**
 * untrusted_listing_text for eval search. Every description is cut to EVAL_TEXT_MAX characters;
 * for the injected listing the cut applies to the original part only and the attack text is
 * appended unchanged, so the published template always reaches the model in full.
 */
export function evalListingText(description: string, original: string | null): string {
  if (original === null) return description.slice(0, EVAL_TEXT_MAX);
  const prefix = `${original}\n\n`;
  if (!description.startsWith(prefix)) {
    throw new AppError(ErrorCode.INTERNAL, 'Injected listing does not extend its original');
  }
  return `${original.slice(0, EVAL_TEXT_MAX)}\n\n${description.slice(prefix.length)}`;
}
