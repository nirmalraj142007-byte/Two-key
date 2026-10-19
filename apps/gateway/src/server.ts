import { installCrashHandlers, loadEnv, reportStartupFailure } from '@twokey/core';
import { createWebhookApi, createWebhookVerifier } from '@twokey/paypal';
import { buildApp } from './app.js';
import { processPendingWebhooks } from './services/webhook-apply.js';

installCrashHandlers('gateway');

async function main(): Promise<void> {
  const env = loadEnv('gateway');
  const paypalCfg = {
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    env: env.PAYPAL_ENV,
  };
  const app = buildApp(env, {
    verifyWebhookSignature: createWebhookVerifier(paypalCfg),
    paypalHealth: createWebhookApi(paypalCfg),
  });

  if (!env.PAYPAL_WEBHOOK_ID)
    app.log.warn('PAYPAL_WEBHOOK_ID is not set: /webhooks/paypal answers 503');

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (err) {
    await app.close().catch(() => {});
    throw err;
  }

  // Phase 9 moves this to pg-boss.
  let retrying = false;
  const retryTimer = setInterval(() => {
    if (retrying) return;
    retrying = true;
    processPendingWebhooks(app.db, app.log)
      .catch((err) => app.log.error({ err }, 'webhook retry loop failed'))
      .finally(() => {
        retrying = false;
      });
  }, 10_000);
  app.addHook('onClose', async () => clearInterval(retryTimer));

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}

main().catch((err) => reportStartupFailure('gateway', err));
