import { timingSafeEqual } from 'node:crypto';
import { AppError, ErrorCode } from '@twokey/core';
import type { FastifyPluginAsync } from 'fastify';
import { registry } from '../metrics.js';

export interface MetricsRouteOptions {
  /** Without a token the route still exists but always answers 401. */
  token?: string | undefined;
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** GET /metrics: Prometheus text format, behind `Authorization: Bearer METRICS_TOKEN`. */
export const metricsRoutes: FastifyPluginAsync<MetricsRouteOptions> = async (app, opts) => {
  app.get('/metrics', async (req, reply) => {
    const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!opts.token || !given || !sameToken(given, opts.token)) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Metrics token required');
    }
    reply.header('content-type', registry.contentType);
    reply.header('cache-control', 'no-store');
    return registry.metrics();
  });
};
