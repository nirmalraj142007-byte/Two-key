/**
 * Reads PayPal authorizations with the PLATFORM credentials and prints their status:
 *
 *   npx dotenv -e .env.gateway -- tsx scripts/auth-status.ts <authorizationId...>
 *
 * Prints only IDs and statuses; never tokens or credentials.
 */
import { createLogger, loadEnv } from '@twokey/core';
import { createPayPal } from '@twokey/paypal';

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error('usage: tsx scripts/auth-status.ts <authorizationId...>');
  process.exit(1);
}
const env = loadEnv('gateway');
const pp = createPayPal({
  clientId: env.PAYPAL_CLIENT_ID,
  clientSecret: env.PAYPAL_CLIENT_SECRET,
  env: env.PAYPAL_ENV,
  logger: createLogger('gateway', 'warn'),
});
for (const id of ids) {
  const auth = await pp.getAuthorization(id);
  console.log(`authorization ${auth.id}: ${auth.status} (GET with platform credentials)`);
}
