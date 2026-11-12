import { formatUSD } from '@twokey/core/money';

export const GATES = ['G0', 'G1', 'G2', 'G3', 'G4'] as const;
export type Gate = (typeof GATES)[number];

/** A share as a percentage; small shares keep two decimals so 3/400 reads 0.75%, not 0.8%. */
export function pct(share: number | null): string {
  if (share === null) return '—';
  const p = share * 100;
  if (p === 0) return '0%';
  return `${p < 1 ? p.toFixed(2) : p.toFixed(1)}%`;
}

/** "13 of 200" — every percentage from a small sample is shown with this next to it. */
export const countOf = (n: number, d: number) =>
  `${n.toLocaleString('en-US')} of ${d.toLocaleString('en-US')}`;

/** A share with its count: "6.5% (13 of 200)". */
export const pctWithCount = (n: number, d: number) =>
  d === 0 ? '—' : `${pct(n / d)} (${countOf(n, d)})`;

/** Model ids without the provider prefix: openai/gpt-oss-20b → gpt-oss-20b. */
export const shortModel = (model: string) => model.slice(model.indexOf('/') + 1);

export function gateLabel(gate: Gate, staticCapCents: number): string {
  switch (gate) {
    case 'G0':
      return 'Prompt guard only';
    case 'G1':
      return 'Per-task cap';
    case 'G2':
      return `Static cap ${formatUSD(staticCapCents)}`;
    case 'G3':
      return 'Approve everything';
    case 'G4':
      return 'Two-Key';
  }
}

/** Explorer rows for a model and filters (the episodes grid lands in phase 21). */
export function episodesHref(params: Record<string, string>): string {
  return `/results/episodes?${new URLSearchParams(params).toString()}`;
}

/** Count of a share of n, as `eval metrics` prints it. */
export const shareCount = (share: number | null, n: number) => Math.round((share ?? 0) * n);

interface CapModel {
  attacked: number;
  cleanWithProposal: number;
  gates: Record<'G2' | 'G4', { letThroughCount: number; honestInterruptedCount: number }>;
  g4Interruptions: { anomalyHold: number; blockedBy: Record<string, number> };
}

/**
 * Static cap (G2) vs Two-Key (G4) on the same proposals, summed over models. The static cap
 * refuses every honest purchase it interrupts; Two-Key refuses only those that break a signed
 * rule and holds the rest for one approval. Same sums as scripts/readme-results.ts.
 */
export function capComparison(models: Record<string, CapModel>) {
  const c = {
    attacked: 0,
    honest: 0,
    staticThrough: 0,
    g4Through: 0,
    staticRefused: 0,
    g4Interrupted: 0,
    g4Refused: 0,
    g4Held: 0,
  };
  for (const m of Object.values(models)) {
    c.attacked += m.attacked;
    c.honest += m.cleanWithProposal;
    c.staticThrough += m.gates.G2.letThroughCount;
    c.g4Through += m.gates.G4.letThroughCount;
    c.staticRefused += m.gates.G2.honestInterruptedCount;
    c.g4Interrupted += m.gates.G4.honestInterruptedCount;
    c.g4Held += m.g4Interruptions.anomalyHold;
    c.g4Refused += Object.values(m.g4Interruptions.blockedBy).reduce((a, b) => a + b, 0);
  }
  return c;
}
