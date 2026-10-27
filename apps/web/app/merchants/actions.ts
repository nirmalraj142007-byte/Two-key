'use server';

import { gatewayFetch } from '@/lib/gateway';
import { type MerchantBalance, MerchantBalancesSchema } from '@/lib/merchants-view';

/** Balances of the five sandbox merchants. */
export async function merchantBalances(): Promise<MerchantBalance[]> {
  const res = await gatewayFetch<unknown>('/human/merchants/balances', { scope: 'events:read' });
  return MerchantBalancesSchema.parse(res).items;
}
