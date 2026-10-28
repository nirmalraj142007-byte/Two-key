import { createLogger } from '@twokey/core';
import { webEnv } from '@/lib/env';

/** The standard error body: one code, one plain sentence, the request ID. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error: { code, message, requestId }, ...extra },
    { status, headers: { 'x-request-id': requestId, 'cache-control': 'no-store', ...headers } },
  );
}

export function hijackLog() {
  return createLogger('web', webEnv().LOG_LEVEL);
}
