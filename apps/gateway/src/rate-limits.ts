import { clientIp } from '@twokey/core';
import type { FastifyRequest } from 'fastify';

/**
 * Rate-limit key for per-IP limits: the same rightmost x-forwarded-for entry the web app's
 * hijack limiter uses, so a client can't pick its own key by adding entries to the left.
 */
export function rateLimitIp(req: FastifyRequest): string {
  const ip = clientIp(req.headers);
  return ip === 'unknown' ? req.ip : ip;
}

/** Requests per minute: per agent session, for all of PayPal's deliveries, per client IP. */
export const RATE_LIMITS = { proposals: 30, webhooks: 600, public: 60 } as const;
