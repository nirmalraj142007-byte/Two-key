import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { AppError, createLogger, type Env, ErrorCode, toHttp } from '@twokey/core';
import type { VerifyWebhookSignature } from '@twokey/paypal';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { dbPlugin } from './plugins/db.js';
import { webhookRoutes } from './routes/webhooks.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

export type AppEnv = Pick<Env<'gateway'>, 'LOG_LEVEL'> &
  Partial<Pick<Env<'gateway'>, 'DATABASE_URL' | 'PAYPAL_WEBHOOK_ID'>>;

export interface AppDeps {
  verifyWebhookSignature?: VerifyWebhookSignature;
}

/** Fastify's own 4xx errors (bad JSON, wrong content type, body too large). */
function isClientError(err: unknown): err is { statusCode: number } {
  const e = err as { code?: unknown; statusCode?: unknown };
  return (
    typeof e?.code === 'string' &&
    e.code.startsWith('FST_') &&
    typeof e.statusCode === 'number' &&
    e.statusCode >= 400 &&
    e.statusCode < 500
  );
}

export function buildApp(env: AppEnv, deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({
    loggerInstance: createLogger('gateway', env.LOG_LEVEL) as FastifyBaseLogger,
    genReqId: () => randomUUID(),
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  app.setErrorHandler((err, req, reply) => {
    const mapped = isClientError(err)
      ? new AppError(ErrorCode.VALIDATION, 'Invalid request', { httpStatus: err.statusCode })
      : err;
    const { status, body } = toHttp(mapped, req.id);
    if (status >= 500) req.log.error({ err }, 'request failed');
    return reply.status(status).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    const { status, body } = toHttp(new AppError(ErrorCode.NOT_FOUND, 'Not found'), req.id);
    return reply.status(status).send(body);
  });

  app.get('/healthz', async () => ({
    ok: true,
    service: 'gateway',
    version,
    commit: process.env.RENDER_GIT_COMMIT ?? 'dev',
  }));

  if (env.DATABASE_URL) app.register(dbPlugin, { url: env.DATABASE_URL });
  app.register(webhookRoutes, {
    webhookId: env.PAYPAL_WEBHOOK_ID,
    verify: deps.verifyWebhookSignature,
  });

  return app;
}
