import { connection } from 'next/server';
import { webEnv } from '@/lib/env';
import { gatewayHealthState } from '@/lib/gateway-wake';
import { allWakeTargets, wakeServices } from '@/lib/wake';

const TIMEOUT_MS = 3_000;

/**
 * Same-origin proxy for the gateway's public GET /healthz/paypal, so the degraded banner needs no
 * CORS. Free hosting: a gateway that has just stopped answering is most likely asleep, so for
 * GATEWAY_WAKE_GRACE_MS this says `waking` (and pings every sleeping service) instead of
 * degraded. Unreachable for longer counts as degraded: purchases can't go through.
 */
export async function GET() {
  await connection();
  const headers = { 'cache-control': 'no-store' };
  try {
    const res = await fetch(new URL('/healthz/paypal', webEnv().GATEWAY_URL), {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json()) as { degraded?: unknown; reason?: unknown };
    if (!res.ok || typeof body.degraded !== 'boolean') throw new Error('bad health answer');
    gatewayHealthState.reachable();
    return Response.json(
      body.degraded
        ? { degraded: true, reason: String(body.reason ?? 'paypal_unreachable') }
        : { degraded: false },
      { headers },
    );
  } catch {
    if (gatewayHealthState.unreachable(Date.now()) === 'waking') {
      wakeServices(allWakeTargets(webEnv()));
      return Response.json({ degraded: false, waking: true }, { headers });
    }
    return Response.json({ degraded: true, reason: 'gateway_unreachable' }, { headers });
  }
}
