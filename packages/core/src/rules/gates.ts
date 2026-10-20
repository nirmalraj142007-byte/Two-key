import { AppError, ErrorCode } from '../errors.js';
import { evaluateAnomaly, evaluateHardRules } from './evaluate.js';
import type { Listing, RuleCard, RuleHit } from './schema.js';

/** Stored with every decision. Bump on any change to gate logic. */
export const GATE_VERSION = 'gates-v1';

/**
 * G0 prompt guard only, G1 per-task cap, G2 static cap, G3 approve everything, G4 Two-Key.
 */
export type Gate = 'G0' | 'G1' | 'G2' | 'G3' | 'G4';

export type GateOutcome = 'capture' | 'hold' | 'block' | 'ask_every_time';

export type GateInput = {
  card?: RuleCard;
  taskCapCents?: number;
  staticCapCents?: number;
  listing: Listing;
  qty: number;
  now: Date;
  recentPurchaseCount: number;
};

function required<T>(value: T | undefined, gate: Gate, field: string): T {
  if (value === undefined) {
    throw new AppError(ErrorCode.VALIDATION, `Gate ${gate} requires ${field}`, {
      details: { gate, field },
    });
  }
  return value;
}

function capGate(
  rule: 'task_cap' | 'static_cap',
  capCents: number,
  i: GateInput,
): { outcome: GateOutcome; hits: RuleHit[] } {
  const orderCents = i.listing.priceCents * i.qty;
  const passed = orderCents <= capCents;
  return {
    outcome: passed ? 'capture' : 'block',
    hits: [{ rule, passed, detail: { expected: capCents, actual: orderCents } }],
  };
}

export function decideGate(gate: Gate, i: GateInput): { outcome: GateOutcome; hits: RuleHit[] } {
  switch (gate) {
    case 'G0':
      return { outcome: 'capture', hits: [] };
    case 'G1':
      return capGate('task_cap', required(i.taskCapCents, gate, 'taskCapCents'), i);
    case 'G2':
      return capGate('static_cap', required(i.staticCapCents, gate, 'staticCapCents'), i);
    case 'G3':
      return { outcome: 'ask_every_time', hits: [] };
    case 'G4': {
      const card = required(i.card, gate, 'card');
      const hard = evaluateHardRules({
        card,
        listing: i.listing,
        qty: i.qty,
        now: i.now,
        recentPurchaseCount: i.recentPurchaseCount,
      });
      if (hard.outcome === 'block') return { outcome: 'block', hits: hard.hits };
      const anomaly = evaluateAnomaly(card, i.listing, i.qty);
      return { outcome: anomaly.outcome, hits: [...hard.hits, anomaly.hit] };
    }
    default:
      throw new AppError(ErrorCode.VALIDATION, `Unknown gate ${String(gate)}`, {
        details: { gate },
      });
  }
}
