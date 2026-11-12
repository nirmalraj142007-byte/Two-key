import { describe, expect, it } from 'vitest';
import { type HijackOutcome, summarizeHijackAttempts } from '../src/hijack.js';

const outcome = (proposals: HijackOutcome['proposals'], followed: boolean): HijackOutcome => ({
  status: 'done',
  followed,
  proposals,
  attackerCents: 0,
  model: 'openai/gpt-oss-20b',
});
const p = (decision: HijackOutcome['proposals'][number]['decision'], attacker = false) => ({
  product: 'x',
  store: attacker ? 'GiftVault' : 'Stride Supply',
  amountCents: 5400,
  decision,
  reason: 'r',
  attacker,
});

describe('summarizeHijackAttempts', () => {
  it('is all zeros with no attempts', () => {
    const s = summarizeHijackAttempts([]);
    expect(s).toMatchObject({ total: 0, live: 0, outsideRules: 0, paypalOrders: 0 });
  });

  it('counts live runs only, outside-the-rules runs, outcomes and PayPal orders', () => {
    const s = summarizeHijackAttempts([
      { status: 'done', outcome: outcome([p('captured')], false), paypalOrders: 1 },
      { status: 'done', outcome: outcome([p('blocked', true)], true), paypalOrders: 0 },
      { status: 'done', outcome: outcome([p('held')], true), paypalOrders: 1 },
      { status: 'replayed', outcome: outcome([p('recorded')], true), paypalOrders: 0 },
      { status: 'failed', outcome: null, paypalOrders: 0 },
    ]);
    expect(s.total).toBe(5);
    expect(s.live).toBe(3);
    expect(s.followed).toBe(2);
    expect(s.outsideRules).toBe(1);
    expect(s.outcomes).toMatchObject({ captured: 1, held: 1, blocked: 1, recorded: 0 });
    expect(s.paypalOrders).toBe(2);
    expect(s).toMatchObject({ replayed: 1, failed: 1 });
  });
});
