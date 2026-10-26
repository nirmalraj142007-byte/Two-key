import { z } from 'zod';
import { toCents } from '../money.js';
import { type Enforcement, type RuleCard, RuleCardSchema } from './schema.js';

/** What the model fills through the forced `emit_rules` tool call. Plain fields only; no cards. */
export const CompilerOutput = z.object({
  perItemCapUsd: z.number().nullable(),
  perOrderCapUsd: z.number().nullable(),
  stores: z.array(z.string()),
  categories: z.array(z.string()).nullable(),
  maxQty: z.number().nullable(),
  frequency: z.object({ maxPurchases: z.number(), windowHours: z.number() }).nullable(),
  expiresInDays: z.number().nullable(),
  advisory: z.array(z.object({ key: z.string(), value: z.string(), label: z.string() })),
  unclear: z.array(z.string()),
});

export type CompilerOutput = z.infer<typeof CompilerOutput>;

export interface RegistryEntry {
  slug: string;
  id: string;
  displayName: string;
  categories: string[];
}

export type Registry = RegistryEntry[];

export interface DraftContext {
  userId: string;
  registry: Registry;
  now: Date;
  defaults: {
    frequency: { maxPurchases: number; windowHours: number };
    holdTimeoutMinutes: number;
    expiresInDays: number;
  };
  /** Placeholder until the route assigns the user's next version. */
  version?: number;
}

export interface DraftResult {
  card: RuleCard | null;
  enforcement: Enforcement;
  advisory: { key: string; value: string; label: string }[];
  warnings: string[];
  needsInput: string[];
}

const DAY_MS = 86_400_000;
const MAX_ADVISORY = 10;
const MAX_TEXT = 120;
const CARD_FIELDS = new Set([
  'perItemCapCents',
  'perOrderCapCents',
  'allowedMerchantIds',
  'allowedCategories',
  'maxQtyPerOrder',
  'frequency',
  'holdTimeoutMinutes',
  'expiresAt',
]);

const norm = (s: string) => s.trim().toLowerCase();

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function usdToCents(usd: number | null): number | null {
  if (usd === null || !Number.isFinite(usd) || usd <= 0 || usd > 1_000_000) return null;
  return toCents(usd.toFixed(2));
}

/** Deterministic: turns the model's fields into an unsigned draft card plus how each field is treated. */
export function toDraftCard(out: CompilerOutput, ctx: DraftContext): DraftResult {
  const warnings: string[] = [];
  const needsInput: string[] = [];
  const enforcement: Enforcement = {};

  // A single stated cap ("max $25" read as an order total) caps each item too.
  const perItemCents = usdToCents(out.perItemCapUsd) ?? usdToCents(out.perOrderCapUsd);
  if (perItemCents === null) needsInput.push('a price cap');

  const merchantIds: string[] = [];
  const stores: RegistryEntry[] = [];
  for (const raw of out.stores) {
    const entry = ctx.registry.find(
      (r) => norm(r.slug) === norm(raw) || norm(r.displayName) === norm(raw),
    );
    if (!entry) {
      warnings.push(`${raw.slice(0, MAX_TEXT)} is not in your stores`);
    } else if (!merchantIds.includes(entry.id)) {
      merchantIds.push(entry.id);
      stores.push(entry);
    }
  }
  if (merchantIds.length === 0) needsInput.push('at least one store');

  const advisory: DraftResult['advisory'] = [];
  for (const a of out.advisory) {
    const key = a.key.trim().slice(0, 40);
    if (!key || CARD_FIELDS.has(key) || advisory.some((x) => x.key === key)) {
      if (key) warnings.push(`Ignored advisory note "${key}"`);
      continue;
    }
    if (advisory.length >= MAX_ADVISORY) break;
    advisory.push({
      key,
      value: a.value.trim().slice(0, MAX_TEXT),
      label: a.label.trim().slice(0, MAX_TEXT) || key,
    });
  }
  for (const u of out.unclear) warnings.push(`Unclear: ${u.slice(0, MAX_TEXT)}`);

  if (perItemCents === null || merchantIds.length === 0) {
    return { card: null, enforcement, advisory, warnings, needsInput };
  }

  enforcement.perItemCapCents = 'enforced';
  enforcement.allowedMerchantIds = 'enforced';

  let maxQty = 1;
  if (out.maxQty === null) {
    enforcement.maxQtyPerOrder = 'default';
  } else {
    maxQty = clampInt(out.maxQty, 1, 20);
    if (maxQty !== out.maxQty) warnings.push(`Quantity limit adjusted to ${maxQty}`);
    enforcement.maxQtyPerOrder = 'enforced';
  }

  let perOrderCents = usdToCents(out.perOrderCapUsd);
  if (perOrderCents === null) {
    perOrderCents = perItemCents * maxQty;
    enforcement.perOrderCapCents = 'default';
  } else {
    if (perOrderCents < perItemCents) {
      perOrderCents = perItemCents;
      warnings.push('Order cap raised to match the item cap');
    }
    enforcement.perOrderCapCents = 'enforced';
  }

  let allowedCategories: string[] | undefined;
  if (out.categories && out.categories.length > 0) {
    const known = new Set(stores.flatMap((s) => s.categories));
    allowedCategories = [];
    for (const c of out.categories) {
      const cat = norm(c).replace(/\s+/g, '_');
      if (known.has(cat)) {
        if (!allowedCategories.includes(cat)) allowedCategories.push(cat);
      } else {
        warnings.push(`${c.slice(0, MAX_TEXT)} is not a category at your stores`);
      }
    }
    if (allowedCategories.length === 0) allowedCategories = undefined;
    else enforcement.allowedCategories = 'enforced';
  }

  let frequency = ctx.defaults.frequency;
  if (out.frequency) {
    frequency = {
      maxPurchases: clampInt(out.frequency.maxPurchases, 1, 50),
      windowHours: clampInt(out.frequency.windowHours, 1, 720),
    };
    enforcement.frequency = 'enforced';
  } else {
    enforcement.frequency = 'default';
  }

  let days = ctx.defaults.expiresInDays;
  if (out.expiresInDays !== null && out.expiresInDays > 0) {
    days = clampInt(out.expiresInDays, 1, 365);
    enforcement.expiresAt = 'enforced';
  } else {
    enforcement.expiresAt = 'default';
  }
  enforcement.holdTimeoutMinutes = 'default';
  for (const a of advisory) enforcement[a.key] = 'advisory';

  const parsed = RuleCardSchema.safeParse({
    version: ctx.version ?? 1,
    userId: ctx.userId,
    currency: 'USD',
    perItemCapCents: perItemCents,
    perOrderCapCents: perOrderCents,
    allowedMerchantIds: merchantIds,
    ...(allowedCategories ? { allowedCategories } : {}),
    maxQtyPerOrder: maxQty,
    frequency,
    holdTimeoutMinutes: ctx.defaults.holdTimeoutMinutes,
    anomaly: { priceRatioThreshold: 1.3 },
    expiresAt: new Date(ctx.now.getTime() + days * DAY_MS).toISOString(),
    advisory,
  });
  if (!parsed.success) {
    warnings.push('These rules could not be turned into a valid card');
    return { card: null, enforcement: {}, advisory, warnings, needsInput };
  }
  return { card: parsed.data, enforcement, advisory, warnings, needsInput };
}
