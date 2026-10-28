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
