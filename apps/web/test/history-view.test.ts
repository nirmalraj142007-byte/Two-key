import { describe, expect, it } from 'vitest';
import type { ProposalView } from '../lib/console-view';
import {
  applyLive,
  awaitingText,
  displayRows,
  type HistoryRow,
  ruleChips,
} from '../lib/history-view';
import { sortMerchants } from '../lib/merchants-view';

function row(over: Partial<HistoryRow> = {}): HistoryRow {
  return {
    proposalId: 'p1',
    createdAt: '2026-10-27T10:00:00.000Z',
    product: 'Cloud Runner CR-1',
    store: 'Stride Supply',
    qty: 1,
    amountCents: 5400,
    decision: 'capture',
    ruleHits: [],
    state: 'authorizing',
    paymentId: 'pay1',
    orderId: null,
    authorizationId: null,
    captureId: null,
    lastSource: 'api_response',
    lastChangeAt: '2026-10-27T10:00:00.000Z',
    buyerPresent: false,
    events: [],
    ...over,
  };
}

function view(over: Partial<ProposalView> = {}): ProposalView {
  return {
    proposalId: 'p1',
    sessionId: 's1',
    createdAt: '2026-10-27T10:00:00.000Z',
    product: 'Cloud Runner CR-1',
    merchant: 'Stride Supply',
    qty: 1,
    amountCents: 5400,
    state: 'captured',
    reason: '',
    paymentId: 'pay1',
    orderId: 'ORDER1',
    authorizationId: 'AUTH1',
    captureId: 'CAP1',
    buyerPresent: false,
    approvalId: null,
    holdDeadlineAt: null,
    ...over,
  };
}

describe('history view', () => {
  it('turns failed rules red and the anomaly amber, and skips passed rules', () => {
    expect(
      ruleChips([
        { rule: 'merchant_allowlist', passed: false, detail: {} },
        { rule: 'per_item_cap', passed: false, detail: {} },
        { rule: 'max_qty', passed: true, detail: {} },
        { rule: 'anomaly', passed: false, detail: {} },
      ]),
    ).toEqual([
      { rule: 'merchant_allowlist', label: 'Store not allowed', kind: 'failed' },
      { rule: 'per_item_cap', label: 'Over item cap', kind: 'failed' },
      { rule: 'anomaly', label: 'Unusual price', kind: 'anomaly' },
    ]);
    expect(ruleChips('nonsense')).toEqual([]);
  });

  it('shows "awaiting PayPal" only while waiting on PayPal', () => {
    const now = Date.parse('2026-10-27T10:00:12.400Z');
    expect(awaitingText(row(), now)).toBe('awaiting PayPal (12 s)');
    expect(awaitingText(row({ state: 'capture_requested' }), now)).toBe('awaiting PayPal (12 s)');
    expect(awaitingText(row({ state: 'captured' }), now)).toBeNull();
    expect(awaitingText(row({ state: 'held' }), now)).toBeNull();
  });

  it('applies a live update forward only', () => {
    const at = new Date('2026-10-27T10:00:05Z');
    const next = applyLive(row(), view(), at);
    expect(next).toMatchObject({
      state: 'captured',
      captureId: 'CAP1',
      lastChangeAt: at.toISOString(),
    });
    // A stale "authorized" after the capture changes nothing.
    expect(applyLive(next as HistoryRow, view({ state: 'authorized' }), at)).toBeNull();
    // Another proposal's event is ignored.
    expect(applyLive(row(), view({ proposalId: 'p2' }), at)).toBeNull();
    // A held row moves on to captured.
    expect(applyLive(row({ state: 'held' }), view(), at)?.state).toBe('captured');
  });

  it('groups rows and adds detail rows for expanded ones', () => {
    const rows = [
      row({ proposalId: 'a', state: 'captured' }),
      row({ proposalId: 'b', state: 'blocked', paymentId: null, amountCents: 18900 }),
      row({ proposalId: 'c', state: 'captured', amountCents: 1000 }),
    ];
    const out = displayRows(rows, 'state', new Set(), new Set(['a']));
    expect(out.map((d) => d.id)).toEqual([
      'group:state:captured',
      'a',
      'detail:a',
      'c',
      'group:state:blocked',
      'b',
    ]);
    expect(out[0]).toMatchObject({ kind: 'group', count: 2, totalCents: 6400 });
    const collapsed = displayRows(rows, 'state', new Set(['captured']), new Set());
    expect(collapsed.map((d) => d.id)).toEqual([
      'group:state:captured',
      'group:state:blocked',
      'b',
    ]);
    expect(displayRows(rows, 'none', new Set(), new Set()).map((d) => d.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('puts the attacker first on the merchants page', () => {
    const base = {
      paypalMerchantId: null,
      grossCapturedCents: 0,
      paypalBalanceCents: null,
      source: 'computed' as const,
      asOf: '',
    };
    const sorted = sortMerchants([
      { ...base, slug: 'stride-supply', displayName: 'Stride Supply', role: 'allowed_demo' },
      { ...base, slug: 'giftvault', displayName: 'GiftVault', role: 'attacker' },
      { ...base, slug: 'corner-pantry', displayName: 'Corner Pantry', role: 'allowed_demo' },
    ]);
    expect(sorted.map((m) => m.slug)).toEqual(['giftvault', 'corner-pantry', 'stride-supply']);
  });
});
