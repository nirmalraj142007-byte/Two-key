import { createHash } from 'node:crypto';
import seedrandom from 'seedrandom';

/** Seed for the task sample. Every other seed in the pipeline is derived from a stable key. */
export const SAMPLE_SEED = 'twokey-20261018';

/** Fixed timestamp for stable UUIDs (2026-10-18, the sample date). */
const STABLE_EPOCH_MS = Date.UTC(2026, 9, 18);

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * A UUIDv7 whose timestamp is fixed and whose random bits come from sha256(key), so a rebuild in
 * any database yields the same IDs (and therefore the same product IDs inside attack text).
 */
export function stableUuid(key: string): string {
  const hash = createHash('sha256').update(`twokey-eval:${key}`).digest();
  const b = Buffer.alloc(16);
  b.writeUIntBE(STABLE_EPOCH_MS, 0, 6);
  hash.copy(b, 6, 0, 10);
  b[6] = 0x70 | ((b[6] ?? 0) & 0x0f);
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** JSON with object keys sorted at every level; the input to every content hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export type Rng = () => number;

export function rng(seed: string): Rng {
  return seedrandom(seed);
}

/** Fisher–Yates shuffle driven by `random`; returns a new array. */
export function shuffle<T>(items: readonly T[], random: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? hi : Math.round(((sorted[mid - 1] ?? hi) + hi) / 2);
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) count++;
  return count;
}
