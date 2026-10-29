import { REPLAY_REASON } from '@twokey/core/hijack';
import type { ApprovalItem } from './approvals-view';
import type { ProposalView, StepEntry } from './console-view';
import type { HijackOutcome, HijackStatus } from './hijack-view';
import type { HistoryRow } from './history-view';
import type { MerchantBalance } from './merchants-view';
import type { RuleLineView } from './rules-view';

// Sample data for `?__state=` screenshots only (see lib/test-states.ts, never used in production).
// Everything is the fictional demo catalog from CLAUDE.md "Demo facts"; no evaluation numbers.

const SESSION = '01900000-0000-7000-8000-00000000f001';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const MIN = 60_000;

export const FIXTURE_SESSION = SESSION;
export const DEMO_REQUEST =
  'Running shoes, size 10, under $70, only Stride Supply or Peak Outfitters, one pair, this week.';

export function fixtureCardLines(): RuleLineView[] {
  return [
    {
      key: 'stores',
      label: 'Stores',
      value: 'Stride Supply, Peak Outfitters',
      enforcement: 'enforced',
    },
    { key: 'perItemCap', label: 'Most per item', value: '$70.00', enforcement: 'enforced' },
    { key: 'maxQty', label: 'Most items per order', value: '1', enforcement: 'enforced' },
    { key: 'size', label: 'Size', value: '10', enforcement: 'advisory' },
  ];
}

export function fixtureProposal(over: Partial<ProposalView> = {}): ProposalView {
  return {
    proposalId: '01900000-0000-7000-8000-00000000a001',
    sessionId: SESSION,
    createdAt: ago(2 * MIN),
    product: 'Cloud Runner CR-1',
    merchant: 'Stride Supply',
    qty: 1,
    amountCents: 5400,
    state: 'captured',
    reason: 'Inside your rules. PayPal captured the payment.',
    paymentId: '01900000-0000-7000-8000-00000000b001',
    orderId: '5O190127TN364715T',
    authorizationId: '0VF52814937998046',
    captureId: '3C679366HH908993F',
    buyerPresent: false,
    approvalId: null,
    holdDeadlineAt: null,
    ...over,
  };
}

/** The three demo outcomes: captured, held, blocked. */
export function fixtureFinalProposals(): ProposalView[] {
  return [
    fixtureProposal(),
    fixtureProposal({
      proposalId: '01900000-0000-7000-8000-00000000a002',
      paymentId: '01900000-0000-7000-8000-00000000b002',
      product: 'Trail Runner TR-2',
      merchant: 'Peak Outfitters',
      amountCents: 6440,
      state: 'held',
      reason: '40% above the usual price at 3 stores. Held for your approval.',
      captureId: null,
      approvalId: '01900000-0000-7000-8000-00000000c001',
      holdDeadlineAt: inMs(14 * MIN),
    }),
    fixtureProposal({
      proposalId: '01900000-0000-7000-8000-00000000a003',
      product: 'Digital gift card $189',
      merchant: 'GiftVault',
      amountCents: 18900,
      state: 'blocked',
      reason: 'GiftVault is not one of your stores. No PayPal order created.',
      paymentId: null,
      orderId: null,
      authorizationId: null,
      captureId: null,
    }),
  ];
}

export function fixtureSteps(): StepEntry[] {
  return [
    {
      turn: 1,
      role: 'assistant',
      text: 'I will look for running shoes in your stores.',
      toolCalls: [{ id: 'c1', name: 'search_products', input: { query: 'running shoes size 10' } }],
      at: ago(90_000),
    },
    {
      turn: 1,
      role: 'tool',
      toolName: 'search_products',
      text: 'Found 3 products: Cloud Runner CR-1 (Stride Supply, $54.00), Trail Runner TR-2 (Peak Outfitters, $64.40), Digital gift card $189 (GiftVault, $189.00).',
      at: ago(80_000),
    },
  ];
}

export function fixtureApproval(over: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    id: '01900000-0000-7000-8000-00000000c001',
    status: 'pending',
    deadlineAt: inMs(14 * MIN),
    decidedAt: null,
    decidedVia: null,
    paymentId: '01900000-0000-7000-8000-00000000b002',
    state: 'held',
    amountCents: 6440,
    amount: '$64.40',
    proposalId: '01900000-0000-7000-8000-00000000a002',
    qty: 1,
    product: 'Trail Runner TR-2',
    merchant: 'Peak Outfitters',
    referencePrice: '$46.00',
    referenceOffers: 3,
    ratio: 1.4,
    ...over,
  };
}

function historyRow(over: Partial<HistoryRow>): HistoryRow {
  const at = over.lastChangeAt ?? ago(5 * MIN);
  return {
    proposalId: '01900000-0000-7000-8000-00000000a001',
    createdAt: at,
    product: 'Cloud Runner CR-1',
    store: 'Stride Supply',
    qty: 1,
    amountCents: 5400,
    decision: 'capture',
    ruleHits: [],
    state: 'captured',
    paymentId: '01900000-0000-7000-8000-00000000b001',
    orderId: '5O190127TN364715T',
    authorizationId: '0VF52814937998046',
    captureId: '3C679366HH908993F',
    lastSource: 'webhook',
    lastChangeAt: at,
    buyerPresent: false,
    events: [],
    ...over,
  };
}

/** partial: rows still waiting on a PayPal webhook; success: final rows in every group. */
export function fixtureHistoryRows(kind: 'partial' | 'success'): HistoryRow[] {
  const captured = historyRow({ lastChangeAt: ago(40 * MIN) });
  const blocked = historyRow({
    proposalId: '01900000-0000-7000-8000-00000000a003',
    product: 'Digital gift card $189',
    store: 'GiftVault',
    amountCents: 18900,
    decision: 'block',
    ruleHits: [{ rule: 'merchant_allowlist', label: 'Store not allowed', kind: 'failed' }],
    state: 'blocked',
    paymentId: null,
    orderId: null,
    authorizationId: null,
    captureId: null,
    lastSource: null,
    lastChangeAt: ago(38 * MIN),
  });
  const voided = historyRow({
    proposalId: '01900000-0000-7000-8000-00000000a002',
    product: 'Trail Runner TR-2',
    store: 'Peak Outfitters',
    amountCents: 6440,
    decision: 'hold',
    ruleHits: [{ rule: 'anomaly', label: 'Unusual price', kind: 'anomaly' }],
    state: 'voided',
    paymentId: '01900000-0000-7000-8000-00000000b002',
    captureId: null,
    lastSource: 'human',
    lastChangeAt: ago(20 * MIN),
  });
  if (kind === 'success') return [captured, voided, blocked];
  return [
    historyRow({
      proposalId: '01900000-0000-7000-8000-00000000a004',
      paymentId: '01900000-0000-7000-8000-00000000b004',
      state: 'authorizing',
      authorizationId: null,
      captureId: null,
      lastSource: 'api_response',
      lastChangeAt: ago(12_000),
    }),
    historyRow({
      proposalId: '01900000-0000-7000-8000-00000000a005',
      paymentId: '01900000-0000-7000-8000-00000000b005',
      store: 'Pacer Goods',
      state: 'capture_requested',
      captureId: null,
      lastSource: 'api_response',
      lastChangeAt: ago(45_000),
    }),
    captured,
    blocked,
  ];
}

const MERCHANTS = [
  ['stride-supply', 'Stride Supply', 'AYT4UTUV3UERE', 'allowed_demo', 5400],
  ['peak-outfitters', 'Peak Outfitters', '8C4RBQX4U6BYL', 'allowed_demo', 0],
  ['pacer-goods', 'Pacer Goods', 'VCGXZWWJN77Y6', 'allowed_demo', 0],
  ['corner-pantry', 'Corner Pantry', 'KH5CUCCNPQRF8', 'allowed_demo', 0],
  ['giftvault', 'GiftVault', 'KJ5QLMZCN224U', 'attacker', 0],
] as const;

/** success: PayPal reported every balance; partial: some; fallback: none (PayPal unreachable). */
export function fixtureMerchants(kind: 'success' | 'partial' | 'fallback'): MerchantBalance[] {
  return MERCHANTS.map(([slug, displayName, paypalMerchantId, role, cents], i) => {
    const fromPayPal = kind === 'success' || (kind === 'partial' && i % 2 === 0);
    return {
      slug,
      displayName,
      role,
      paypalMerchantId,
      grossCapturedCents: cents,
      paypalBalanceCents: fromPayPal ? 500_000 + cents - (cents > 0 ? 237 : 0) : null,
      paypalPaymentsReceived: fromPayPal ? (cents > 0 ? 1 : 0) : null,
      paypalTransactionsAsOf: fromPayPal ? ago(3 * 60 * MIN) : null,
      source: fromPayPal ? 'paypal' : 'computed',
      asOf: ago(MIN),
    };
  });
}

export function fixtureHijackStatus(live: boolean): HijackStatus {
  return live
    ? { triesLeftThisHour: 4, attemptsLeftToday: 37, tokensLeftToday: 182_000, live: true }
    : { triesLeftThisHour: 4, attemptsLeftToday: 0, tokensLeftToday: 0, live: false };
}

export function fixtureHijackOutcome(kind: 'done' | 'replayed' | 'failed'): HijackOutcome {
  if (kind === 'failed') {
    return {
      status: 'failed',
      followed: null,
      proposals: [],
      attackerCents: 0,
      model: '',
      message: 'This attempt took too long to finish. Try again.',
    };
  }
  return {
    status: kind,
    followed: true,
    proposals: [
      {
        product: 'Digital gift card $189',
        store: 'GiftVault',
        amountCents: 18900,
        decision: 'blocked',
        reason: 'GiftVault is not one of your stores. No PayPal order created.',
        attacker: true,
      },
    ],
    attackerCents: 0,
    model: 'openai/gpt-oss-20b',
    ...(kind === 'replayed'
      ? { message: REPLAY_REASON.caps, recordedAt: ago(2 * 24 * 60 * MIN) }
      : {}),
  };
}

/** The same sentence /api/hijack sends with its 429. */
export const RATE_LIMITED_MESSAGE = "That's 5 tries this hour. Try again in 42 minutes.";
