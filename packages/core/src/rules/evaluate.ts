import type { Listing, RuleCard, RuleHit } from './schema.js';

/** Minimum number of offers for the same product before their median counts as a reference. */
export const MIN_REFERENCE_OFFERS = 3;

/** Ratio thresholds are compared in integer basis points to avoid float edge cases (1.3 × 5000). */
const RATIO_SCALE = 10_000;

export function evaluateHardRules(i: {
  card: RuleCard;
  listing: Listing;
  qty: number;
  now: Date;
  recentPurchaseCount: number;
}): { outcome: 'pass' | 'block'; hits: RuleHit[] } {
  const { card, listing, qty, now, recentPurchaseCount } = i;
  const orderCents = listing.priceCents * qty;

  // Every rule is evaluated, in a fixed order, so the user sees all the reasons at once.
  const hits: RuleHit[] = [
    {
      rule: 'expiry',
      passed: now.getTime() < Date.parse(card.expiresAt),
      detail: { expected: card.expiresAt, actual: now.toISOString() },
    },
    {
      rule: 'merchant_allowlist',
      passed: card.allowedMerchantIds.includes(listing.merchantId),
      detail: { expected: card.allowedMerchantIds, actual: listing.merchantId },
    },
    {
      rule: 'per_item_cap',
      passed: listing.priceCents <= card.perItemCapCents,
      detail: { expected: card.perItemCapCents, actual: listing.priceCents },
    },
    {
      rule: 'per_order_cap',
      passed: orderCents <= card.perOrderCapCents,
      detail: { expected: card.perOrderCapCents, actual: orderCents },
    },
    {
      rule: 'max_qty',
      passed: qty <= card.maxQtyPerOrder,
      detail: { expected: card.maxQtyPerOrder, actual: qty },
    },
    card.allowedCategories === undefined
      ? { rule: 'category', passed: true, detail: { expected: 'any', actual: listing.category } }
      : {
          rule: 'category',
          passed: card.allowedCategories.includes(listing.category),
          detail: { expected: card.allowedCategories, actual: listing.category },
        },
    {
      rule: 'frequency',
      passed: recentPurchaseCount < card.frequency.maxPurchases,
      detail: {
        expected: {
          maxPurchases: card.frequency.maxPurchases,
          windowHours: card.frequency.windowHours,
        },
        actual: recentPurchaseCount,
      },
    },
  ];

  return { outcome: hits.every((h) => h.passed) ? 'pass' : 'block', hits };
}

export function evaluateAnomaly(
  card: RuleCard,
  listing: Listing,
  _qty: number,
): { outcome: 'capture' | 'hold'; hit: RuleHit } {
  const threshold = card.anomaly.priceRatioThreshold;
  let reference: { cents: number; source: 'product_median' | 'category_median' } | null = null;
  if (listing.referencePriceCents != null && listing.referenceOffers >= MIN_REFERENCE_OFFERS) {
    reference = { cents: listing.referencePriceCents, source: 'product_median' };
  } else if (listing.categoryMedianCents != null) {
    reference = { cents: listing.categoryMedianCents, source: 'category_median' };
  }

  if (reference === null) {
    return {
      outcome: 'capture',
      hit: {
        rule: 'anomaly',
        passed: true,
        detail: { expected: { threshold }, actual: 'no_reference' },
      },
    };
  }

  // Hold only when strictly above threshold × reference.
  const scaledThreshold = Math.round(threshold * RATIO_SCALE);
  const hold = listing.priceCents * RATIO_SCALE > scaledThreshold * reference.cents;
  const ratio = Math.round((listing.priceCents / reference.cents) * 100) / 100;

  return {
    outcome: hold ? 'hold' : 'capture',
    hit: {
      rule: 'anomaly',
      passed: !hold,
      detail: {
        expected: { threshold, referenceCents: reference.cents, source: reference.source },
        actual: { priceCents: listing.priceCents, ratio },
      },
    },
  };
}
