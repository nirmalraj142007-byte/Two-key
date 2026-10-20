import type { Env } from '@twokey/core';
import { createPayPal, type Logger, type PayPal } from '@twokey/paypal';

let instance: PayPal | undefined;

/** One PayPal client per process, so the OAuth token is shared by every request. */
export function getPayPal(
  env: Pick<Env<'gateway'>, 'PAYPAL_CLIENT_ID' | 'PAYPAL_CLIENT_SECRET' | 'PAYPAL_ENV'>,
  logger: Logger,
): PayPal {
  instance ??= createPayPal({
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    env: env.PAYPAL_ENV,
    logger,
  });
  return instance;
}
