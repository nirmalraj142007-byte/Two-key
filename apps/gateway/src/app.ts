import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { AppError, createLogger, type Env, ErrorCode, toHttp } from '@twokey/core';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

export function buildApp(env: Pick<Env<'gateway'>, 'LOG_LEVEL'>): FastifyInstance {
  const app = Fastify({
    loggerInstance: createLogger('gateway', env.LOG_LEVEL) as FastifyBaseLogger,
    genReqId: () => randomUUID(),
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  app.setErrorHandler((err, req, reply) => {
    const { status, body } = toHttp(err, req.id);
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

  return app;
}
