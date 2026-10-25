import type { Channel3Api } from '@channel3/sdk';
import { Channel3, Channel3Error } from '@channel3/sdk';
import { AppError, ErrorCode } from '@twokey/core';
import { catalogSnapshots, type Db, listings, merchants } from '@twokey/db';
import { and, eq, sql } from 'drizzle-orm';

const LIVE_TAG = 'live_cache';
const TIMEOUT_SECONDS = 10;

export interface LiveSearchOptions {
  maxPriceCents?: number;
  limit: number;
}

/** A mapped offer, stored as a listing so that propose_purchase can resolve its product_id. */
export interface LiveItem {
  listingId: string;
  title: string;
  store: string;
  priceCents: number;
  category: string;
  description: string;
}

export interface LiveSearchResult {
  items: LiveItem[];
  /** Offers whose website is not one of our registered merchants; they are never listed. */
  unmappedOffers: number;
}

export type Channel3Search = (
  query: string,
  opts: { maxPriceCents?: number; limit: number },
) => Promise<Channel3Api.Product[]>;

export interface Channel3Service {
  search(db: Db, query: string, opts: LiveSearchOptions): Promise<LiveSearchResult>;
}

function normalizeSite(site: string): string {
  return site
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

function toUpstreamError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const status = err instanceof Channel3Error ? err.statusCode : undefined;
  const retryable = status === undefined || status === 429 || status >= 500;
  return new AppError(ErrorCode.UPSTREAM_CHANNEL3, 'Product search is unavailable right now', {
    retryable,
    details: status === undefined ? {} : { status },
    cause: err,
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? hi : Math.round(((sorted[mid - 1] ?? hi) + hi) / 2);
}

function categoryOf(product: Channel3Api.Product): string {
  const slug = product.category?.slug ?? product.category?.title ?? 'other';
  return (
    slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '') || 'other'
  );
}

async function liveSnapshotId(db: Db): Promise<string> {
  await db
    .insert(catalogSnapshots)
    .values({ kind: 'live_cache', contentSha256: 'live', gitTag: LIVE_TAG })
    .onConflictDoNothing();
  const [row] = await db
    .select({ id: catalogSnapshots.id })
    .from(catalogSnapshots)
    .where(and(eq(catalogSnapshots.kind, 'live_cache'), eq(catalogSnapshots.gitTag, LIVE_TAG)))
    .limit(1);
  if (!row) throw new AppError(ErrorCode.INTERNAL, 'Internal error');
  return row.id;
}

/**
 * Live catalog search. The key lives in the gateway only; every product_id the agent sees is a
 * listing row written here, so the gateway can resolve price and payee itself at proposal time.
 */
export function createChannel3Service(
  apiKey: string | undefined,
  search?: Channel3Search,
): Channel3Service {
  const run: Channel3Search =
    search ??
    (async (query, opts) => {
      if (!apiKey) {
        throw new AppError(ErrorCode.UPSTREAM_CHANNEL3, 'Live product search is not configured', {
          retryable: false,
        });
      }
      const client = new Channel3({ apiKey, timeoutInSeconds: TIMEOUT_SECONDS, maxRetries: 1 });
      const page = await client.products.search({
        query,
        limit: opts.limit,
        filters: {
          availability: ['InStock'],
          ...(opts.maxPriceCents === undefined
            ? {}
            : { price: { max_price: opts.maxPriceCents / 100 } }),
        },
      });
      return page.data;
    });

  return {
    async search(db, query, opts) {
      let products: Channel3Api.Product[];
      try {
        products = await run(query, opts);
      } catch (err) {
        throw toUpstreamError(err);
      }

      const registry = await db
        .select({
          id: merchants.id,
          displayName: merchants.displayName,
          sites: merchants.channel3WebsiteIds,
        })
        .from(merchants);
      const bySite = new Map<string, (typeof registry)[number]>();
      for (const m of registry) for (const site of m.sites) bySite.set(normalizeSite(site), m);

      const snapshotId = await liveSnapshotId(db);
      const items: LiveItem[] = [];
      let unmappedOffers = 0;

      for (const product of products) {
        const offers = (product.offers ?? []).filter(
          (o) => o.availability === 'InStock' && o.price.currency === 'USD',
        );
        const prices = offers.map((o) => Math.round(o.price.price * 100));
        const reference = prices.length >= 3 ? median(prices) : null;
        for (const offer of offers) {
          const merchant = bySite.get(normalizeSite(offer.domain));
          if (!merchant) {
            unmappedOffers += 1;
            continue;
          }
          const priceCents = Math.round(offer.price.price * 100);
          if (opts.maxPriceCents !== undefined && priceCents > opts.maxPriceCents) continue;
          const values = {
            snapshotId,
            channel3ProductId: product.id,
            groupKey: product.id,
            merchantId: merchant.id,
            title: product.title,
            brandName: product.brands?.[0]?.name ?? null,
            category: categoryOf(product),
            priceCents,
            referencePriceCents: reference,
            referenceNOffers: prices.length,
            structuredAttrs: product.structured_attributes ?? {},
            description: product.description ?? '',
          };
          const [row] = await db
            .insert(listings)
            .values(values)
            .onConflictDoUpdate({
              target: [listings.snapshotId, listings.groupKey, listings.merchantId],
              set: {
                title: sql`excluded.title`,
                priceCents: sql`excluded.price_cents`,
                category: sql`excluded.category`,
                referencePriceCents: sql`excluded.reference_price_cents`,
                referenceNOffers: sql`excluded.reference_n_offers`,
                structuredAttrs: sql`excluded.structured_attrs`,
                description: sql`excluded.description`,
              },
            })
            .returning({ id: listings.id });
          if (!row) continue;
          items.push({
            listingId: row.id,
            title: product.title,
            store: merchant.displayName,
            priceCents,
            category: values.category,
            description: values.description,
          });
        }
      }
      return { items: items.slice(0, opts.limit), unmappedOffers };
    },
  };
}
