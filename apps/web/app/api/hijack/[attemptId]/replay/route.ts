import { requestSlowReplay } from '@/lib/hijack';
import { errorResponse, hijackLog } from '../../respond';

/**
 * Public. The page waited 30 s without a live result: show a recorded run instead. Accepted only
 * for a live attempt that has been running that long; anything else is a no-op.
 */
export async function POST(_req: Request, ctx: RouteContext<'/api/hijack/[attemptId]/replay'>) {
  const requestId = crypto.randomUUID();
  const { attemptId } = await ctx.params;
  try {
    return Response.json({ replaying: await requestSlowReplay(attemptId) });
  } catch (err) {
    hijackLog().error({ err, requestId }, 'hijack slow replay failed');
    return errorResponse(503, 'INTERNAL', 'Could not switch to a recorded run.', requestId);
  }
}
