import { z } from 'zod';

/** PayPal's honor period is 3 days (4,320 minutes); holds must always end before it. */
export const HONOR_PERIOD_MINUTES = 4320;

export const RuleCardSchema = z
  .object({
    version: z.number().int().positive(),
    userId: z.string().uuid(),
    currency: z.literal('USD'),
    perItemCapCents: z.number().int().positive(),
    perOrderCapCents: z.number().int().positive(),
    allowedMerchantIds: z.array(z.string().uuid()).min(1),
    allowedCategories: z.array(z.string()).optional(),
    maxQtyPerOrder: z.number().int().min(1).max(20),
    frequency: z.object({
      maxPurchases: z.number().int().min(1).max(50),
      windowHours: z.number().int().min(1).max(720),
    }),
    holdTimeoutMinutes: z
      .number()
      .int()
      .min(1)
      .max(HONOR_PERIOD_MINUTES - 60),
    anomaly: z.object({ priceRatioThreshold: z.number().min(1).max(5).default(1.3) }),
    expiresAt: z.string().datetime(),
    advisory: z
      .array(z.object({ key: z.string(), value: z.string(), label: z.string() }))
      .default([]),
  })
  .refine(
    (c) => c.perItemCapCents <= c.perOrderCapCents,
    'per-item cap must not exceed per-order cap',
  );

export type RuleCard = z.infer<typeof RuleCardSchema>;

/** How each rule-card field is treated, for display: checked by the gateway, shown only, or defaulted. */
export type Enforcement = Record<string, 'enforced' | 'advisory' | 'default'>;

export const ListingInput = z.object({
  id: z.string().min(1),
  merchantId: z.string().uuid(),
  priceCents: z.number().int().positive(),
  category: z.string(),
  /** Median price of the same product across stores; meaningful only when referenceOffers >= 3. */
  referencePriceCents: z.number().int().positive().nullable(),
  referenceOffers: z.number().int().min(0),
  categoryMedianCents: z.number().int().positive().nullable().optional(),
});

export type Listing = z.infer<typeof ListingInput>;

export type RuleId =
  | 'expiry'
  | 'merchant_allowlist'
  | 'per_item_cap'
  | 'per_order_cap'
  | 'max_qty'
  | 'category'
  | 'frequency';

export type RuleHit = {
  rule: RuleId | 'anomaly' | 'task_cap' | 'static_cap';
  passed: boolean;
  detail: { expected: unknown; actual: unknown };
};
