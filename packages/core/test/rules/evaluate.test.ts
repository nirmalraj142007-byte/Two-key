import { describe, expect, it } from 'vitest';
import { evaluateAnomaly, evaluateHardRules } from '../../src/rules/evaluate.js';
import { RuleCardSchema } from '../../src/rules/schema.js';
import { CR1, demoCard, GIFT_CARD, listing, NOW, PEAK, TR2 } from './fixtures.js';

const base = { card: demoCard(), listing: CR1, qty: 1, now: NOW, recentPurchaseCount: 0 };

function failed(r: ReturnType<typeof evaluateHardRules>) {
  return r.hits.filter((h) => !h.passed).map((h) => h.rule);
}

describe('evaluateHardRules', () => {
  it('evaluates every rule in order', () => {
    const r = evaluateHardRules(base);
    expect(r.outcome).toBe('pass');
    expect(r.hits.map((h) => h.rule)).toEqual([
      'expiry',
      'merchant_allowlist',
      'per_item_cap',
      'per_order_cap',
      'max_qty',
      'category',
      'frequency',
    ]);
  });

  it('passes at exactly the per-item cap', () => {
    const r = evaluateHardRules({ ...base, listing: listing({ priceCents: 7000 }) });
    expect(r.outcome).toBe('pass');
  });

  it('blocks one cent over the per-item cap', () => {
    const r = evaluateHardRules({ ...base, listing: listing({ priceCents: 7001 }) });
    expect(r.outcome).toBe('block');
    expect(r.hits.find((h) => h.rule === 'per_item_cap')).toEqual({
      rule: 'per_item_cap',
      passed: false,
      detail: { expected: 7000, actual: 7001 },
    });
  });

  it('blocks an allowlist miss even when the price is fine', () => {
    const r = evaluateHardRules({ ...base, listing: { ...CR1, merchantId: GIFT_CARD.merchantId } });
    expect(r.outcome).toBe('block');
    expect(failed(r)).toEqual(['merchant_allowlist']);
  });

  it('does not short-circuit: the gift card reports every failing rule', () => {
    const r = evaluateHardRules({ ...base, listing: GIFT_CARD });
    expect(r.hits).toHaveLength(7);
    expect(failed(r)).toEqual(['merchant_allowlist', 'per_item_cap', 'per_order_cap']);
  });

  it('blocks when the per-order total exceeds the cap', () => {
    const card = demoCard({ maxQtyPerOrder: 2, perOrderCapCents: 10000 });
    const r = evaluateHardRules({ ...base, card, qty: 2 });
    expect(failed(r)).toEqual(['per_order_cap']);
    expect(r.hits[3]?.detail).toEqual({ expected: 10000, actual: 10800 });
  });

  it('blocks over the quantity limit', () => {
    const card = demoCard({ perOrderCapCents: 20000 });
    expect(failed(evaluateHardRules({ ...base, card, qty: 2 }))).toEqual(['max_qty']);
  });

  it('blocks at and after expiry', () => {
    const at = new Date(demoCard().expiresAt);
    expect(failed(evaluateHardRules({ ...base, now: at }))).toEqual(['expiry']);
    const before = new Date(at.getTime() - 1);
    expect(evaluateHardRules({ ...base, now: before }).outcome).toBe('pass');
  });

  it('skips the category rule when no categories are set', () => {
    const r = evaluateHardRules(base);
    expect(r.hits[5]).toMatchObject({ rule: 'category', passed: true });
  });

  it('blocks a category outside the allowed list', () => {
    const card = demoCard({ allowedCategories: ['socks'] });
    expect(failed(evaluateHardRules({ ...base, card }))).toEqual(['category']);
    const ok = demoCard({ allowedCategories: ['running_shoes'] });
    expect(evaluateHardRules({ ...base, card: ok }).outcome).toBe('pass');
  });

  it('blocks when recent purchases equal the frequency limit', () => {
    expect(evaluateHardRules({ ...base, recentPurchaseCount: 2 }).outcome).toBe('pass');
    expect(failed(evaluateHardRules({ ...base, recentPurchaseCount: 3 }))).toEqual(['frequency']);
  });

  it('ignores advisory entries', () => {
    const advisory = [
      { key: 'size', value: '10', label: "Agent's job — not checked by Two-Key" },
      { key: 'colour', value: 'blue', label: "Agent's job — not checked by Two-Key" },
    ];
    for (const l of [CR1, TR2, GIFT_CARD, listing({ priceCents: 7001 })]) {
      const without = evaluateHardRules({ ...base, listing: l });
      const withAdvisory = evaluateHardRules({ ...base, card: demoCard({ advisory }), listing: l });
      expect(withAdvisory).toEqual(without);
      expect(evaluateAnomaly(demoCard({ advisory }), l, 1)).toEqual(
        evaluateAnomaly(demoCard(), l, 1),
      );
    }
  });
});

describe('evaluateAnomaly', () => {
  const card = demoCard();

  it('holds TR-2 at 1.40× the 3-store median', () => {
    const r = evaluateAnomaly(card, TR2, 1);
    expect(r.outcome).toBe('hold');
    expect(r.hit).toEqual({
      rule: 'anomaly',
      passed: false,
      detail: {
        expected: { threshold: 1.3, referenceCents: 4600, source: 'product_median' },
        actual: { priceCents: 6440, ratio: 1.4 },
      },
    });
  });

  it('captures CR-1 below its reference', () => {
    expect(evaluateAnomaly(card, CR1, 1).outcome).toBe('capture');
  });

  it('captures at exactly the threshold and holds one cent above', () => {
    const at = listing({ merchantId: PEAK, priceCents: 6500, referencePriceCents: 5000 });
    expect(evaluateAnomaly(card, at, 1).outcome).toBe('capture');
    expect(evaluateAnomaly(card, { ...at, priceCents: 6501 }, 1).outcome).toBe('hold');
  });

  it('falls back to the category median with fewer than 3 offers', () => {
    const l = listing({ priceCents: 6440, referenceOffers: 2, categoryMedianCents: 6000 });
    const r = evaluateAnomaly(card, l, 1);
    expect(r.outcome).toBe('capture');
    expect(r.hit.detail.expected).toMatchObject({
      referenceCents: 6000,
      source: 'category_median',
    });
    expect(evaluateAnomaly(card, { ...l, categoryMedianCents: 4000 }, 1).outcome).toBe('hold');
  });

  it('captures with no reference at all', () => {
    const l = listing({ priceCents: 99999, referenceOffers: 1, categoryMedianCents: null });
    const r = evaluateAnomaly(card, l, 1);
    expect(r.outcome).toBe('capture');
    expect(r.hit.detail.actual).toBe('no_reference');
  });

  it('uses the card threshold', () => {
    const strict = demoCard({ anomaly: { priceRatioThreshold: 1 } });
    expect(evaluateAnomaly(strict, listing({ priceCents: 5501 }), 1).outcome).toBe('hold');
  });
});

describe('RuleCardSchema', () => {
  it('accepts the demo card and defaults advisory and threshold', () => {
    const { advisory: _a, ...raw } = demoCard();
    const parsed = RuleCardSchema.parse({ ...raw, anomaly: {} });
    expect(parsed.advisory).toEqual([]);
    expect(parsed.anomaly.priceRatioThreshold).toBe(1.3);
  });

  it('rejects holdTimeoutMinutes 4320 (would exceed the honor period)', () => {
    expect(RuleCardSchema.safeParse(demoCard({ holdTimeoutMinutes: 4320 })).success).toBe(false);
    expect(RuleCardSchema.safeParse(demoCard({ holdTimeoutMinutes: 4260 })).success).toBe(true);
    expect(RuleCardSchema.safeParse(demoCard({ holdTimeoutMinutes: 4261 })).success).toBe(false);
  });

  it('rejects a per-item cap above the per-order cap', () => {
    const r = RuleCardSchema.safeParse(demoCard({ perItemCapCents: 8000 }));
    expect(r.success).toBe(false);
  });

  it('strips unknown keys', () => {
    const parsed = RuleCardSchema.parse({ ...demoCard(), approveAll: true });
    expect(parsed).not.toHaveProperty('approveAll');
  });
});
