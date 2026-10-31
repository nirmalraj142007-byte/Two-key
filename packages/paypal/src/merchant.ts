import { createPayPal, type Logger, type PayPalConfig } from './client.js';
import type { OrdersApi } from './orders.js';

/** What Two-Key does with a payee merchant's own credentials: release its authorizations. */
export type MerchantPayPal = Pick<OrdersApi, 'voidAuthorization' | 'getAuthorization'>;

export interface MerchantCredentials {
  clientId: string;
  clientSecret: string;
}

/** Looks up the client for a merchant slug; undefined when Two-Key has no credentials for it. */
export type MerchantPayPalLookup = (slug: string) => MerchantPayPal | undefined;

/**
 * One PayPal client per payee merchant, created on first use and cached, so each merchant's
 * OAuth token is fetched once and reused. PayPal refuses a platform void on a third-party
 * payee's authorization (403 PERMISSION_DENIED); the payee's own app may void it. This is the
 * sandbox stand-in for PayPal partner permissions.
 */
export function createMerchantPayPal(
  credentials: Record<string, MerchantCredentials>,
  cfg: { env: 'sandbox' | 'live'; logger: Logger; onCall?: PayPalConfig['onCall'] },
): MerchantPayPalLookup {
  const clients = new Map<string, MerchantPayPal>();
  return (slug) => {
    if (!Object.hasOwn(credentials, slug)) return undefined;
    let client = clients.get(slug);
    if (!client) {
      const c = credentials[slug] as MerchantCredentials;
      const pp = createPayPal({
        clientId: c.clientId,
        clientSecret: c.clientSecret,
        env: cfg.env,
        logger: cfg.logger.child({ merchant: slug }),
        ...(cfg.onCall ? { onCall: cfg.onCall } : {}),
      });
      client = {
        voidAuthorization: (i) => pp.voidAuthorization(i),
        getAuthorization: (id) => pp.getAuthorization(id),
      };
      clients.set(slug, client);
    }
    return client;
  };
}
