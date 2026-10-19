import { loadEnv } from '@twokey/core';
import { createWebhookVerifier } from '@twokey/paypal';
import { buildApp } from './app.js';
import { processPendingWebhooks } from './services/webhook-apply.js';

let env: ReturnType<typeof loadEnv<'gateway'>>;
try {
  env = loadEnv('gateway');
} catch (err) {
  process.stderr.write(`gateway: ${err instanceof Error ? err.message : 'invalid config'}\n`);
  process.exit(1);
}

const app = buildApp(env, {
  verifyWebhookSignature: createWebhookVerifier({
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    env: env.PAYPAL_ENV,
  }),
});

if (!env.PAYPAL_WEBHOOK_ID)
  app.log.warn('PAYPAL_WEBHOOK_ID is not set: /webhooks/paypal answers 503');

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

app.listen({ port: env.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error({ err }, 'gateway failed to start');
  process.exit(1);
});
