/**
 * Registers (or repairs) the gateway's PayPal webhook subscription.
 *
 *   npm run paypal:webhook -- --url https://<gateway host>
 *
 * Uses the PayPal credentials from .env.gateway; they must be the same REST app the deployed
 * gateway uses, or signature verification will fail.
 */
import {
  loadEnv,
  missingWebhookEvents,
  REQUIRED_WEBHOOK_EVENTS,
  webhookUrlFor,
} from '@twokey/core';
import { createWebhookApi } from '@twokey/paypal';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const base = argValue('--url');
if (!base || !/^https:\/\//.test(base)) {
  console.error('usage: npm run paypal:webhook -- --url https://<public gateway base url>');
  process.exit(1);
}

const env = loadEnv('gateway');
const api = createWebhookApi({
  clientId: env.PAYPAL_CLIENT_ID,
  clientSecret: env.PAYPAL_CLIENT_SECRET,
  env: env.PAYPAL_ENV,
});
const url = webhookUrlFor(base);
const wanted: string[] = [...REQUIRED_WEBHOOK_EVENTS];

const existing = (await api.listWebhooks()).find((w) => w.url === url);
let id: string;
if (!existing) {
  id = (await api.createWebhook({ url, eventTypes: wanted })).id;
  console.log(`created webhook for ${url}`);
} else {
  id = existing.id;
  const extra = existing.eventTypes.filter((e) => !wanted.includes(e));
  if (missingWebhookEvents(existing.eventTypes).length === 0 && extra.length === 0) {
    console.log(`webhook for ${url} already has the required events`);
  } else {
    await api.updateWebhookEvents(id, wanted);
    console.log(`updated event types of the webhook for ${url}`);
  }
}
console.log(`PAYPAL_WEBHOOK_ID=${id}`);
