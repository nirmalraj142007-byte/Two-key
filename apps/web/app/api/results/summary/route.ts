import { AppError, createLogger } from '@twokey/core';
import { connection } from 'next/server';
import { webEnv } from '@/lib/env';
import { getResultsSummary } from '@/lib/results-queries';

/** Public: aggregate evaluation numbers only (no listing text, no brand names). */
export async function GET() {
  await connection();
  const requestId = crypto.randomUUID();
  try {
    return Response.json(await getResultsSummary(), {
      headers: { 'cache-control': 'public, max-age=60', 'x-request-id': requestId },
    });
  } catch (err) {
    createLogger('web', webEnv().LOG_LEVEL).error({ err, requestId }, 'results summary failed');
    const code = err instanceof AppError ? err.code : 'INTERNAL';
    return Response.json(
      { error: { code, message: 'Results are unavailable right now', requestId } },
      { status: 503, headers: { 'x-request-id': requestId } },
    );
  }
}
