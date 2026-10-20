import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import { decideGate, type Gate } from '../../src/rules/gates.js';
import { CR1, demoCard, GIFT_CARD, listing, NOW, TR2 } from './fixtures.js';

const base = {
  card: demoCard(),
  taskCapCents: 6000,
  staticCapCents: 5000,
  listing: CR1,
  qty: 1,
  now: NOW,
  recentPurchaseCount: 0,
};

describe('decideGate', () => {
  it.each<[Gate, string]>([
    ['G0', 'capture'],
    ['G1', 'capture'],
    ['G2', 'block'],
    ['G3', 'ask_every_time'],
    ['G4', 'capture'],
  ])('price 5400, task cap 6000, static cap 5000: %s -> %s', (gate, outcome) => {
    expect(decideGate(gate, base).outcome).toBe(outcome);
  });

  it('G0 and G3 record no hits', () => {
    expect(decideGate('G0', base).hits).toEqual([]);
    expect(decideGate('G3', base).hits).toEqual([]);
  });

  it('G1 and G2 compare the order total', () => {
    expect(decideGate('G1', { ...base, qty: 2 })).toEqual({
      outcome: 'block',
      hits: [{ rule: 'task_cap', passed: false, detail: { expected: 6000, actual: 10800 } }],
    });
    expect(decideGate('G2', base).hits).toEqual([
      { rule: 'static_cap', passed: false, detail: { expected: 5000, actual: 5400 } },
    ]);
  });

  it('G4 demo: CR-1 captures, TR-2 holds, the gift card blocks', () => {
    expect(decideGate('G4', { ...base, listing: CR1 }).outcome).toBe('capture');
    const hold = decideGate('G4', { ...base, listing: TR2 });
    expect(hold.outcome).toBe('hold');
    expect(hold.hits).toHaveLength(8);
    expect(hold.hits.at(-1)?.detail.actual).toEqual({ priceCents: 6440, ratio: 1.4 });
    expect(decideGate('G4', { ...base, listing: GIFT_CARD }).outcome).toBe('block');
  });

  it('G4: block wins over anomaly', () => {
    const blocked = listing({
      merchantId: GIFT_CARD.merchantId,
      priceCents: 5500,
      referencePriceCents: 550,
    });
    const r = decideGate('G4', { ...base, listing: blocked });
    expect(r.outcome).toBe('block');
    expect(r.hits.some((h) => h.rule === 'anomaly')).toBe(false);
  });

  it.each<[Gate, keyof typeof base]>([
    ['G1', 'taskCapCents'],
    ['G2', 'staticCapCents'],
    ['G4', 'card'],
  ])('%s throws VALIDATION without %s', (gate, field) => {
    const { [field]: _omit, ...rest } = base;
    expect(() => decideGate(gate, rest as typeof base)).toThrow(AppError);
    try {
      decideGate(gate, rest as typeof base);
    } catch (e) {
      expect((e as AppError).code).toBe('VALIDATION');
    }
  });

  it('G0, G2 and G3 do not need a card', () => {
    const { card: _c, ...rest } = base;
    expect(decideGate('G0', rest).outcome).toBe('capture');
    expect(decideGate('G2', rest).outcome).toBe('block');
    expect(decideGate('G3', rest).outcome).toBe('ask_every_time');
  });
});
