import { createRequire } from 'node:module';
import { missingWebhookEvents, webhookUrlFor } from '@twokey/core';
import type { WebhookApi } from '@twokey/paypal';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

export type HealthPayPal = Pick<WebhookApi, 'checkAuth' | 'listWebhooks'>;

export interface HealthRouteOptions {
  /** Runs `select 1`; absent when the gateway has no database configured. */
  checkDb?: (() => Promise<void>) | undefined;
  paypal?: HealthPayPal | undefined;
  webhookId?: string | undefined;
  publicBaseUrl?: string | undefined;
  /** How long PayPal results are reused, so uptime monitors don't hammer PayPal. */
  cacheMs?: number;
}

type Check = 'ok' | 'fail' | 'not_configured';
type WebhookCheck = Check | 'not_found' | 'wrong_url' | 'missing_events';

interface PayPalHealth {
  paypalAuth: Check;
  webhookSubscriptions: WebhookCheck;
  missing?: string[];
}

const CHECK_TIMEOUT_MS = 5_000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('health check timed out')), CHECK_TIMEOUT_MS).unref(),
    ),
  ]);
}

async function checkPayPal(
  opts: HealthRouteOptions,
  log: FastifyBaseLogger,
): Promise<PayPalHealth> {
  const { paypal, webhookId, publicBaseUrl } = opts;
  if (!paypal) return { paypalAuth: 'not_configured', webhookSubscriptions: 'not_configured' };
  try {
    await withTimeout(paypal.checkAuth());
  } catch (err) {
    log.warn({ err }, 'deep health: paypal auth failed');
    return { paypalAuth: 'fail', webhookSubscriptions: 'fail' };
  }
  if (!webhookId || !publicBaseUrl) {
    return { paypalAuth: 'ok', webhookSubscriptions: 'not_configured' };
  }
  try {
    const hook = (await withTimeout(paypal.listWebhooks())).find((w) => w.id === webhookId);
    if (!hook) return { paypalAuth: 'ok', webhookSubscriptions: 'not_found' };
    if (hook.url !== webhookUrlFor(publicBaseUrl)) {
      return { paypalAuth: 'ok', webhookSubscriptions: 'wrong_url' };
    }
    const missing = missingWebhookEvents(hook.eventTypes);
    return missing.length > 0
      ? { paypalAuth: 'ok', webhookSubscriptions: 'missing_events', missing }
      : { paypalAuth: 'ok', webhookSubscriptions: 'ok' };
  } catch (err) {
    log.warn({ err }, 'deep health: listing paypal webhooks failed');
    return { paypalAuth: 'ok', webhookSubscriptions: 'fail' };
  }
}

/**
 * GET /healthz is Render's liveness check and never touches the DB or PayPal.
 * GET /healthz/deep is for humans and uptime monitors: 503 unless the DB answers, PayPal
 * accepts our credentials and the webhook subscription is complete.
 */
export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (app, opts) => {
  const cacheMs = opts.cacheMs ?? 60_000;
  let cached: { at: number; result: Promise<PayPalHealth> } | undefined;

  app.get('/healthz', async () => ({
    ok: true,
    service: 'gateway',
    version,
    commit: process.env.RENDER_GIT_COMMIT ?? 'dev',
  }));

  app.get('/healthz/deep', async (req, reply) => {
    let db: Check = 'not_configured';
    if (opts.checkDb) {
      try {
        await withTimeout(opts.checkDb());
        db = 'ok';
      } catch (err) {
        req.log.warn({ err }, 'deep health: db check failed');
        db = 'fail';
      }
    }

    if (!cached || Date.now() - cached.at >= cacheMs) {
      cached = { at: Date.now(), result: checkPayPal(opts, app.log) };
    }
    const paypal = await cached.result;

    const body = { db, ...paypal };
    const healthy =
      db === 'ok' && paypal.paypalAuth === 'ok' && paypal.webhookSubscriptions === 'ok';
    return reply.status(healthy ? 200 : 503).send(body);
  });
};
