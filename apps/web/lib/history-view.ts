import { z } from 'zod';
import { PAYMENT_STATES, type ProposalView } from './console-view';

// The /history audit log: what GET /api/history returns, and the pure helpers the grid uses.

export const EVENT_SOURCES = ['api_response', 'webhook', 'reconciler', 'human', 'timer'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const HistoryEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  source: z.enum(EVENT_SOURCES),
  type: z.string(),
  from: z.enum(PAYMENT_STATES).nullable(),
  to: z.enum(PAYMENT_STATES).nullable(),
  paypalEventId: z.string().nullable(),
});
export type HistoryEvent = z.infer<typeof HistoryEventSchema>;

export const RuleChipSchema = z.object({
  rule: z.string(),
  label: z.string(),
  /** failed: a hard rule stopped it (red); anomaly: an unusual price held it (amber). */
  kind: z.enum(['failed', 'anomaly']),
});
export type RuleChip = z.infer<typeof RuleChipSchema>;

export const HISTORY_STATES = [...PAYMENT_STATES, 'blocked'] as const;
export type HistoryState = (typeof HISTORY_STATES)[number];

export const HistoryRowSchema = z.object({
  proposalId: z.string(),
  createdAt: z.string(),
  product: z.string(),
  store: z.string(),
  qty: z.number().int(),
  amountCents: z.number().int(),
  decision: z.enum(['capture', 'hold', 'block', 'ask_every_time']).nullable(),
  ruleHits: z.array(RuleChipSchema),
  state: z.enum(HISTORY_STATES),
  paymentId: z.string().nullable(),
  orderId: z.string().nullable(),
  authorizationId: z.string().nullable(),
  captureId: z.string().nullable(),
  lastSource: z.enum(EVENT_SOURCES).nullable(),
  /** When the row last changed: the payment's updated_at, else the proposal time. */
  lastChangeAt: z.string(),
  /** Vaulted payments are authorized with nobody at the PayPal checkout. */
  buyerPresent: z.boolean(),
  events: z.array(HistoryEventSchema),
});
export type HistoryRow = z.infer<typeof HistoryRowSchema>;

export const HistoryResponseSchema = z.object({ rows: z.array(HistoryRowSchema) });

const RULE_LABEL: Record<string, string> = {
  expiry: 'Rules expired',
  merchant_allowlist: 'Store not allowed',
  per_item_cap: 'Over item cap',
  per_order_cap: 'Over order cap',
  max_qty: 'Too many',
  category: 'Category',
  frequency: 'Too often',
  anomaly: 'Unusual price',
  task_cap: 'Over task cap',
  static_cap: 'Over flat cap',
};

const StoredHit = z.object({ rule: z.string(), passed: z.boolean() });

/** gate_decisions.rule_hits to chips: only what stopped or held the purchase. */
export function ruleChips(raw: unknown): RuleChip[] {
  const parsed = z.array(StoredHit).safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data
    .filter((h) => !h.passed)
    .map((h) => ({
      rule: h.rule,
      label: RULE_LABEL[h.rule] ?? h.rule,
      kind: h.rule === 'anomaly' ? 'anomaly' : 'failed',
    }));
}

/** States where Two-Key has asked PayPal and is waiting for the answer or its webhook. */
const AWAITING: ReadonlySet<HistoryState> = new Set([
  'authorizing',
  'authorized',
  'capture_requested',
  'void_requested',
]);

export function isAwaitingPayPal(state: HistoryState): boolean {
  return AWAITING.has(state);
}

/** "awaiting PayPal (12 s)", or null when the row isn't waiting. */
export function awaitingText(row: Pick<HistoryRow, 'state' | 'lastChangeAt'>, now: number) {
  if (!isAwaitingPayPal(row.state)) return null;
  const s = Math.max(0, Math.floor((now - Date.parse(row.lastChangeAt)) / 1000));
  return s < 120 ? `awaiting PayPal (${s} s)` : `awaiting PayPal (${Math.floor(s / 60)} min)`;
}

const RANK: Record<HistoryState, number> = {
  authorizing: 0,
  authorized: 1,
  held: 2,
  capture_requested: 3,
  void_requested: 3,
  captured: 4,
  voided: 4,
  expired: 4,
  denied: 4,
  failed: 4,
  blocked: 4,
};

/**
 * A payment.updated event applied to a row. Returns null when it changes nothing, so stale or
 * out-of-order events never move a row backwards.
 */
export function applyLive(row: HistoryRow, view: ProposalView, now: Date): HistoryRow | null {
  if (view.proposalId !== row.proposalId || view.state === 'recorded') return null;
  const state = view.state;
  // A finished row never changes state again.
  const forward = state !== row.state && RANK[row.state] < 4 && RANK[state] >= RANK[row.state];
  const ids = {
    paymentId: row.paymentId ?? view.paymentId,
    orderId: row.orderId ?? view.orderId,
    authorizationId: row.authorizationId ?? view.authorizationId,
    captureId: row.captureId ?? view.captureId,
  };
  const idsChanged =
    ids.paymentId !== row.paymentId ||
    ids.orderId !== row.orderId ||
    ids.authorizationId !== row.authorizationId ||
    ids.captureId !== row.captureId;
  if (!forward && !idsChanged) return null;
  return {
    ...row,
    ...ids,
    ...(forward ? { state, lastChangeAt: now.toISOString() } : {}),
  };
}

export type GroupBy = 'none' | 'state' | 'store';

/** Display grouping key for a row. */
export function groupKey(row: HistoryRow, by: Exclude<GroupBy, 'none'>): string {
  return by === 'store' ? row.store : row.state;
}

export type DisplayRow =
  | { kind: 'group'; id: string; key: string; count: number; totalCents: number; open: boolean }
  | { kind: 'row'; id: string; row: HistoryRow; expanded: boolean }
  | { kind: 'detail'; id: string; row: HistoryRow };

/**
 * The Community fallback for row grouping and master/detail: a flat list of group headers,
 * data rows and detail rows, rendered by AG Grid as full-width rows. Groups keep the order of
 * their first row; rows keep their order inside a group.
 */
export function displayRows(
  rows: HistoryRow[],
  by: GroupBy,
  collapsed: ReadonlySet<string>,
  expanded: ReadonlySet<string>,
): DisplayRow[] {
  const withDetail = (r: HistoryRow): DisplayRow[] => {
    const open = expanded.has(r.proposalId);
    const out: DisplayRow[] = [{ kind: 'row', id: r.proposalId, row: r, expanded: open }];
    if (open) out.push({ kind: 'detail', id: `detail:${r.proposalId}`, row: r });
    return out;
  };
  if (by === 'none') return rows.flatMap(withDetail);
  const groups = new Map<string, HistoryRow[]>();
  for (const r of rows) {
    const k = groupKey(r, by);
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }
  const out: DisplayRow[] = [];
  for (const [key, list] of groups) {
    const open = !collapsed.has(key);
    out.push({
      kind: 'group',
      id: `group:${by}:${key}`,
      key,
      count: list.length,
      totalCents: list.reduce((n, r) => n + r.amountCents, 0),
      open,
    });
    if (open) out.push(...list.flatMap(withDetail));
  }
  return out;
}

export const SOURCE_LABEL: Record<EventSource, string> = {
  api_response: 'API response',
  webhook: 'Webhook',
  reconciler: 'Reconciler',
  human: 'Human',
  timer: 'Timer',
};
