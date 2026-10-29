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
  /**
   * True when a payment has waited on PayPal since before `since` and no webhook has arrived
   * after it. Absent without a database.
   */
  webhookLagSince?: ((since: Date) => Promise<boolean>) | undefined;
  /** How long PayPal results are reused, so uptime monitors don't hammer PayPal. */
  cacheMs?: number;
  now?: () => Date;
}

/** Why /healthz/paypal reports degraded. */
export type DegradedReason = 'paypal_unreachable' | 'webhook_subscription' | 'webhook_lag';
export interface PayPalStatus {
  degraded: boolean;
  reason?: DegradedReason;
}

/** No webhook for this long while payments wait on PayPal counts as degraded. */
export const WEBHOOK_LAG_MS = 30 * 60_000;

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
 * GET /healthz/paypal is public: { degraded, reason? } from the PayPal parts of the deep check
 * plus "no webhook received in 30 min while payments are pending", cached 60 s.
 */
export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (app, opts) => {
  const cacheMs = opts.cacheMs ?? 60_000;
  const now = opts.now ?? (() => new Date());
  let cached: { at: number; result: Promise<PayPalHealth> } | undefined;
  let cachedStatus: { at: number; result: Promise<PayPalStatus> } | undefined;

  const paypalHealth = () => {
    if (!cached || Date.now() - cached.at >= cacheMs) {
      cached = { at: Date.now(), result: checkPayPal(opts, app.log) };
    }
    return cached.result;
  };

  async function paypalStatus(): Promise<PayPalStatus> {
    const health = await paypalHealth();
    if (health.paypalAuth === 'fail') return { degraded: true, reason: 'paypal_unreachable' };
    if (health.webhookSubscriptions !== 'ok' && health.webhookSubscriptions !== 'not_configured') {
      return { degraded: true, reason: 'webhook_subscription' };
    }
    if (opts.webhookLagSince) {
      try {
        const since = new Date(now().getTime() - WEBHOOK_LAG_MS);
        if (await withTimeout(opts.webhookLagSince(since))) {
          return { degraded: true, reason: 'webhook_lag' };
        }
      } catch (err) {
        // The database is /healthz/deep's concern; this endpoint is about PayPal only.
        app.log.warn({ err }, 'paypal health: webhook lag check failed');
      }
    }
    return { degraded: false };
  }

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

    const paypal = await paypalHealth();

    const body = { db, ...paypal };
    const healthy =
      db === 'ok' && paypal.paypalAuth === 'ok' && paypal.webhookSubscriptions === 'ok';
    return reply.status(healthy ? 200 : 503).send(body);
  });

  // Public and cheap: the web app's degraded banner polls it. Always 200; the body says.
  app.get('/healthz/paypal', async (_req, reply) => {
    if (!cachedStatus || Date.now() - cachedStatus.at >= cacheMs) {
      cachedStatus = { at: Date.now(), result: paypalStatus() };
    }
    reply.header('cache-control', `public, max-age=${Math.floor(cacheMs / 1000)}`);
    return cachedStatus.result;
  });
};
