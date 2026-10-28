import { connection } from 'next/server';
import { attemptView } from '@/lib/hijack';
import { errorResponse, hijackLog } from '../respond';

/** Public: an attempt's status and, once finished, its result card and steps (no text). */
export async function GET(_req: Request, ctx: RouteContext<'/api/hijack/[attemptId]'>) {
  await connection();
  const requestId = crypto.randomUUID();
  const { attemptId } = await ctx.params;
  try {
    const view = await attemptView(attemptId);
    if (!view) return errorResponse(404, 'NOT_FOUND', 'No such attempt.', requestId);
    return Response.json(view, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    hijackLog().error({ err, requestId }, 'hijack attempt read failed');
    return errorResponse(503, 'INTERNAL', 'The result is unavailable right now.', requestId);
  }
}
