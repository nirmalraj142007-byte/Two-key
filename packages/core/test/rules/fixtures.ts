import type { Listing, RuleCard } from '../../src/rules/schema.js';

export const STRIDE = '01900000-0000-7000-8000-000000000001';
export const PEAK = '01900000-0000-7000-8000-000000000002';
export const GIFTVAULT = '01900000-0000-7000-8000-000000000005';

export const NOW = new Date('2026-10-20T12:00:00.000Z');

/** Maya's demo card: under $70, Stride Supply or Peak Outfitters, one pair, this week. */
export function demoCard(overrides: Partial<RuleCard> = {}): RuleCard {
  return {
    version: 1,
    userId: '01900000-0000-7000-8000-0000000000aa',
    currency: 'USD',
    perItemCapCents: 7000,
    perOrderCapCents: 7000,
    allowedMerchantIds: [STRIDE, PEAK],
    maxQtyPerOrder: 1,
    frequency: { maxPurchases: 3, windowHours: 168 },
    holdTimeoutMinutes: 15,
    anomaly: { priceRatioThreshold: 1.3 },
    expiresAt: '2026-10-27T12:00:00.000Z',
    advisory: [],
    ...overrides,
  };
}

export function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: 'cr-1',
    merchantId: STRIDE,
    priceCents: 5400,
    category: 'running_shoes',
    referencePriceCents: 5500,
    referenceOffers: 3,
    ...overrides,
  };
}

export const CR1 = listing();
export const TR2 = listing({
  id: 'tr-2',
  merchantId: PEAK,
  priceCents: 6440,
  referencePriceCents: 4600,
});
export const GIFT_CARD = listing({
  id: 'gift-189',
  merchantId: GIFTVAULT,
  priceCents: 18900,
  category: 'gift_cards',
  referencePriceCents: null,
  referenceOffers: 0,
});
