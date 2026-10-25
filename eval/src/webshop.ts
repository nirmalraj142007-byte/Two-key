import { existsSync, readFileSync } from 'node:fs';
import { AppError, ErrorCode } from '@twokey/core';
import { z } from 'zod';
import { rng, sha256 } from './util.js';

export const WEBSHOP_FILE = 'eval/data/webshop/items_human_ins.json';

const RawInstruction = z.object({
  asin: z.string(),
  instruction: z.string(),
  attributes: z.array(z.string()).default([]),
  options: z.array(z.string()).default([]),
  instruction_attributes: z.array(z.string()).default([]),
  instruction_options: z.array(z.string()).default([]),
  assignment_id: z.string(),
  price_upper: z.number().optional(),
});
const RawFile = z.record(z.string(), z.array(RawInstruction));

export interface WebshopInstruction {
  /** `${asin}:${assignment_id}`, unique per crowdworker instruction. */
  id: string;
  asin: string;
  instruction: string;
  instructionAttributes: string[];
  instructionOptions: string[];
  priceUpperDollars?: number;
}

export interface WebshopFile {
  instructions: WebshopInstruction[];
  sha256: string;
  bytes: number;
  /** Skipped like WebShop's get_human_goals does: no instruction_attributes. */
  skippedNoAttributes: number;
}

export function loadWebshop(path: string): WebshopFile {
  if (!existsSync(path)) {
    throw new AppError(
      ErrorCode.CONFIG_INVALID,
      `Missing ${path}. Download items_human_ins.json (see DATA_LICENCES.md, WebShop section) into eval/data/webshop/.`,
    );
  }
  const buf = readFileSync(path);
  const parsed = RawFile.parse(JSON.parse(buf.toString('utf8')));
  const seen = new Set<string>();
  const instructions: WebshopInstruction[] = [];
  let skippedNoAttributes = 0;
  for (const [asin, items] of Object.entries(parsed)) {
    for (const item of items) {
      if (item.instruction_attributes.length === 0) {
        skippedNoAttributes++;
        continue;
      }
      const id = `${asin}:${item.assignment_id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      instructions.push({
        id,
        asin,
        instruction: item.instruction,
        instructionAttributes: item.instruction_attributes,
        instructionOptions: item.instruction_options,
        ...(item.price_upper === undefined ? {} : { priceUpperDollars: item.price_upper }),
      });
    }
  }
  return { instructions, sha256: sha256(buf), bytes: buf.length, skippedNoAttributes };
}

const PRICE_PHRASE = /,?\s*(?:and\s+)?price lower than ([\d.]+) dollars/i;

/** A cap stated in the data: price_upper if present, else the instruction's price phrase. */
export function explicitPriceCapDollars(item: WebshopInstruction): number | null {
  if (item.priceUpperDollars !== undefined && item.priceUpperDollars < 1_000_000) {
    return item.priceUpperDollars;
  }
  const m = PRICE_PHRASE.exec(item.instruction);
  return m?.[1] ? Number(m[1]) : null;
}

/** The search query: the instruction minus any price phrase and trailing periods. */
export function searchQuery(instruction: string): string {
  return stripPeriods(instruction.replace(PRICE_PHRASE, '').trim());
}

/** Python's str.strip('.'). */
export function stripPeriods(s: string): string {
  return s.replace(/^\.+|\.+$/g, '');
}

/** WebShop goal.py: PRICE_RANGE = [10.0 * i for i in range(1, 100)]. */
export const PRICE_RANGE_DOLLARS = Array.from({ length: 99 }, (_, i) => 10 * (i + 1));

export interface CapDraw {
  method: 'webshop_goal_py' | 'explicit';
  /** Base price: the median price of the task's frozen Channel3 results. */
  basePriceCents: number | null;
  seed: string | null;
  /** The first four PRICE_RANGE values above the base price. */
  priceRangeDollars: number[];
  /** random.sample(price_range, 2), in draw order. */
  sampledDollars: number[];
  priceUpperDollars: number;
}

/**
 * WebShop's get_human_goals rule: take the first four PRICE_RANGE steps above the price, sample
 * two without replacement and keep the larger. Fewer than two steps means no cap (null), as in
 * goal.py (price_upper = 1000000).
 */
export function webshopCapDraw(basePriceCents: number, seed: string): CapDraw | null {
  const price = basePriceCents / 100;
  const range = PRICE_RANGE_DOLLARS.filter((p) => p > price).slice(0, 4);
  if (range.length < 2) return null;
  const random = rng(seed);
  const pool = [...range];
  const sampled: number[] = [];
  for (let k = 0; k < 2; k++) {
    const i = Math.floor(random() * pool.length);
    sampled.push(pool.splice(i, 1)[0] as number);
  }
  return {
    method: 'webshop_goal_py',
    basePriceCents,
    seed,
    priceRangeDollars: range,
    sampledDollars: sampled,
    priceUpperDollars: Math.max(...sampled),
  };
}

/** goal.py: instruction.strip('.') + ', and price lower than {price_upper:.2f} dollars'. */
export function instructionWithCap(instruction: string, priceUpperDollars: number): string {
  return `${stripPeriods(instruction)}, and price lower than ${priceUpperDollars.toFixed(2)} dollars`;
}
