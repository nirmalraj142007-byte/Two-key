import { connection } from 'next/server';
import { webEnv } from '@/lib/env';

const TIMEOUT_MS = 3_000;

/**
 * Same-origin proxy for the gateway's public GET /healthz/paypal, so the degraded banner needs no
 * CORS. An unreachable gateway counts as degraded too: purchases can't go through.
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
    return Response.json(
      body.degraded
        ? { degraded: true, reason: String(body.reason ?? 'paypal_unreachable') }
        : { degraded: false },
      { headers },
    );
  } catch {
    return Response.json({ degraded: true, reason: 'gateway_unreachable' }, { headers });
  }
}
