import { z } from 'zod';
import { requestSlowReplay } from '@/lib/hijack';
import { errorResponse, hijackLog } from '../../respond';

/** `started`: the agent has sent a step. Missing or unreadable counts as not started. */
const Body = z.object({ started: z.boolean().default(false) });

/**
 * Public. The page waited without a live result (30 s once the agent started, 75 s while the
 * free-hosting services wake): show a recorded run instead. Accepted only for a live attempt that
 * has been running that long; anything else is a no-op.
 */
export async function POST(req: Request, ctx: RouteContext<'/api/hijack/[attemptId]/replay'>) {
  const requestId = crypto.randomUUID();
  const { attemptId } = await ctx.params;
  const body = Body.safeParse(await req.json().catch(() => ({})));
  const started = body.success ? body.data.started : false;
  try {
    return Response.json({ replaying: await requestSlowReplay(attemptId, started) });
  } catch (err) {
    hijackLog().error({ err, requestId }, 'hijack slow replay failed');
    return errorResponse(503, 'INTERNAL', 'Could not switch to a recorded run.', requestId);
  }
}
