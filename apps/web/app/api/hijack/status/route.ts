import { connection } from 'next/server';
import { hijackCaps } from '@/lib/hijack';
import { clientIp, hijackPointsLeft, ipHash } from '@/lib/rate-limit';
import { errorResponse, hijackLog } from '../respond';

/** Public: tries left this hour for this visitor, and today's live allowance. */
export async function GET(req: Request) {
  await connection();
  const requestId = crypto.randomUUID();
  try {
    const [tries, caps] = await Promise.all([
      hijackPointsLeft(ipHash(clientIp(req.headers))),
      hijackCaps(),
    ]);
    return Response.json(
      {
        triesLeftThisHour: tries,
        attemptsLeftToday: caps.attemptsLeft,
        tokensLeftToday: caps.tokensLeft,
        live: caps.live,
      },
      { headers: { 'cache-control': 'no-store', 'x-request-id': requestId } },
    );
  } catch (err) {
    hijackLog().error({ err, requestId }, 'hijack status failed');
    return errorResponse(503, 'INTERNAL', 'Status is unavailable right now.', requestId);
  }
}
