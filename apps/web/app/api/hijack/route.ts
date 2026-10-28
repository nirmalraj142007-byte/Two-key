import { InjectionText } from '@twokey/core';
import { z } from 'zod';
import { startHijackAttempt } from '@/lib/hijack';
import { clientIp, consumeHijackPoint, ipHash } from '@/lib/rate-limit';
import { errorResponse, hijackLog } from './respond';

/** Text only: JSON with two fields. No files, no URLs fetched, nothing else accepted. */
const Body = z.object({
  injectionText: InjectionText,
  acceptedNotice: z.literal(true),
});
const MAX_BODY_BYTES = 16 * 1024;

const INVALID_TEXT = 'Paste 1 to 2,000 characters of text and tick the notice.';

/**
 * Public. Starts one hijack attempt: 5 per IP per hour; live while today's attempt and token
 * caps last, otherwise a recorded replay. The text is stored and shown as text only.
 */
export async function POST(req: Request) {
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const type = req.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    return errorResponse(415, 'VALIDATION', 'Send the text as JSON.', requestId);
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return errorResponse(413, 'VALIDATION', INVALID_TEXT, requestId);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return errorResponse(400, 'VALIDATION', INVALID_TEXT, requestId);
  }
  const body = Body.safeParse(json);
  if (!body.success) return errorResponse(400, 'VALIDATION', INVALID_TEXT, requestId);

  const key = ipHash(clientIp(req.headers));
  try {
    const point = await consumeHijackPoint(key);
    if (!point.ok) {
      const minutes = point.retryAfterMinutes;
      return errorResponse(
        429,
        'RATE_LIMITED',
        `That's 5 tries this hour. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        requestId,
        { retryAfterMinutes: minutes },
        { 'retry-after': String(minutes * 60) },
      );
    }
    const started = await startHijackAttempt(body.data.injectionText, key, requestId);
    if (!started.ok) return errorResponse(503, 'INTERNAL', started.message, requestId);
    hijackLog().info(
      { requestId, attemptId: started.attemptId, mode: started.mode },
      'hijack attempt started',
    );
    return Response.json(
      { attemptId: started.attemptId, attemptToken: started.attemptToken, mode: started.mode },
      { headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } },
    );
  } catch (err) {
    // Fail closed: no attempt, no run.
    hijackLog().error({ err, requestId }, 'hijack attempt failed');
    return errorResponse(
      503,
      'INTERNAL',
      'The hijack box is unavailable right now. Try again in a few minutes.',
      requestId,
    );
  }
}
