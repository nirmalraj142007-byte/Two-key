import {
  installCrashHandlers,
  LISTEN_HOST,
  listeningOn,
  loadEnv,
  reportStartupFailure,
} from '@twokey/core';
import { createWebhookApi, createWebhookVerifier } from '@twokey/paypal';
import { buildApp } from './app.js';
import { startJobs } from './jobs/boss.js';

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

  // Hooks, plugins and decorators must all be registered before listen(); after it,
  // Fastify throws. Only the job workers start once the server is up (pg-boss stops on close).
  try {
    await app.listen({ port: env.PORT, host: LISTEN_HOST });
    app.log.info(listeningOn(app.server.address()), 'listening');
  } catch (err) {
    await app.close().catch(() => {});
    throw err;
  }

  await startJobs(app);

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
