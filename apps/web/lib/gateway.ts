import { AppError, ErrorCode } from '@twokey/core';
import { headers } from 'next/headers';
import { connection } from 'next/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { webEnv } from './env';
import { mintAssertion, type Scope } from './human-assertion';

const ErrorEnvelope = z.object({
  error: z.object({ code: z.enum(ErrorCode), message: z.string(), requestId: z.string() }),
});

export interface GatewayRequest {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  /** The one scope this call needs; omit for scope-free reads such as /human/me. */
  scope?: Scope;
}

/** Calls a /human/* gateway route as the signed-in user, with a fresh single-use assertion. */
export async function gatewayFetch<T>(path: string, req: GatewayRequest = {}): Promise<T> {
  // Always request-time: each call mints a fresh, random, single-use assertion.
  await connection();
  const session = await auth();
  if (!session?.userId) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Sign in first');
  const assertion = await mintAssertion(session.userId, session.role, req.scope ? [req.scope] : []);

  const requestId = (await headers()).get('x-request-id') ?? crypto.randomUUID();
  const res = await fetch(new URL(path, webEnv().GATEWAY_URL), {
    method: req.method ?? 'GET',
    headers: {
      authorization: `Bearer ${assertion}`,
      'x-request-id': requestId,
      ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
    cache: 'no-store',
  });

  const json: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const envelope = ErrorEnvelope.safeParse(json);
    if (envelope.success) {
      const { code, message, requestId: gatewayRequestId } = envelope.data.error;
      throw new AppError(code, message, {
        httpStatus: res.status,
        retryable: res.status === 429 || res.status >= 500,
        details: { requestId: gatewayRequestId },
      });
    }
    throw new AppError(ErrorCode.INTERNAL, 'Internal error', { httpStatus: res.status });
  }
  return json as T;
}
