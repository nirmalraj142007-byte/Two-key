import { z } from 'zod';

// What GET /human/merchants/balances returns (apps/gateway/src/services/balances.ts).

export const MerchantBalanceSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  role: z.enum(['allowed_demo', 'attacker']),
  paypalMerchantId: z.string().nullable(),
  /** Gross captured to this payee by Two-Key, in cents. */
  grossCapturedCents: z.number().int().nonnegative(),
  /** PayPal's reported balance after fees, in cents; null when PayPal didn't give one. */
  paypalBalanceCents: z.number().int().nonnegative().nullable(),
  /** Completed incoming payments from PayPal Transaction Search; null when unavailable. */
  paypalPaymentsReceived: z.number().int().nonnegative().nullable(),
  /** When PayPal last refreshed its transaction log. */
  paypalTransactionsAsOf: z.string().nullable(),
  source: z.enum(['paypal', 'computed']),
  asOf: z.string(),
});
export type MerchantBalance = z.infer<typeof MerchantBalanceSchema>;

export const MerchantBalancesSchema = z.object({ items: z.array(MerchantBalanceSchema) });

/** The attacker first (it is the point of the page), then stores by name. */
export function sortMerchants(items: MerchantBalance[]): MerchantBalance[] {
  return [...items].sort(
    (a, b) =>
      Number(b.role === 'attacker') - Number(a.role === 'attacker') ||
      a.displayName.localeCompare(b.displayName),
  );
}
