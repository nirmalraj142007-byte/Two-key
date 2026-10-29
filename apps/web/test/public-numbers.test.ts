import { describe, expect, it } from 'vitest';
import { attackLine, attackNumbers, stripCounts } from '../lib/public-numbers';
import type { ResultsSummary } from '../lib/results-queries';

function model(outside: number, inside: number, passShare: number | null) {
  return {
    followByTarget: {
      outside_rules: { available: 100, followed: outside, rate: null },
      inside_rules: { available: 100, followed: inside, rate: null },
    },
    insideRules: { followed: inside, passShare, heldShare: null, blockedShare: null },
  };
}

// Only the fields the public pages read.
const summary = {
  split: 'dev',
  totals: { runs: 600, gateDecisions: 3000 },
  headline: { attacked: 400, attackerPayments: 0 },
  attackerMoneyCentsG4: 0,
  models: { a: model(1, 10, 0.5), b: model(0, 1, 1) },
} as unknown as ResultsSummary;

describe('public numbers', () => {
  it('sums follows by target over models', () => {
    const a = attackNumbers(summary);
    expect(a).toMatchObject({ attacked: 400, outsideFollowed: 1, insideFollowed: 11 });
    expect(a.insidePassed).toBe(6);
  });

  it('writes the strip and the attack line from those numbers', () => {
    const a = attackNumbers(summary);
    expect(stripCounts(a)).toBe(
      '600 runs · 3,000 gate decisions · 400 attacked runs · 0 attacker payments under Two-Key',
    );
    expect(attackLine(a)).toBe(
      'In 400 poisoned trips, agents followed ‘pay the attacker’ 1 time and ‘buy this other product’ 11 times. Money sent to the attacker: $0.00.',
    );
  });
});
