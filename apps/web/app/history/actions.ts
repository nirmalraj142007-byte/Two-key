'use server';

import { z } from 'zod';
import { gatewayFetch } from '@/lib/gateway';

const Stats = z.object({ openAuthorizations: z.number().int().nonnegative() });

/** PayPal authorizations still open for the signed-in user (held or in flight). */
export async function openAuthorizations(): Promise<number> {
  const res = await gatewayFetch<unknown>('/human/stats', { scope: 'approvals:decide' });
  return Stats.parse(res).openAuthorizations;
}
