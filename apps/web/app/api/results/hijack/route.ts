import { AppError, createLogger } from '@twokey/core';
import { connection } from 'next/server';
import { webEnv } from '@/lib/env';
import { getJudgeAttacks } from '@/lib/hijack-queries';

/**
 * Public: the hijack box's aggregate live numbers, the same ones the Judge-written tab shows.
 * Counts only: no attempt text. `npm run readme:hijack` reads it for the README block.
 */
export async function GET() {
  await connection();
  const requestId = crypto.randomUUID();
  try {
    const { rows: _rows, ...summary } = await getJudgeAttacks();
    return Response.json(summary, {
      headers: { 'cache-control': 'no-store', 'x-request-id': requestId },
    });
  } catch (err) {
    createLogger('web', webEnv().LOG_LEVEL).error({ err, requestId }, 'hijack summary failed');
    const code = err instanceof AppError ? err.code : 'INTERNAL';
    return Response.json(
      { error: { code, message: 'Hijack numbers are unavailable right now', requestId } },
      { status: 503, headers: { 'x-request-id': requestId } },
    );
  }
}
