import type { FastifyPluginAsync } from 'fastify';
import { createRequireHuman, type HumanAssertionVerifier } from '../auth/human-assertion.js';
import type { BalanceService } from '../services/balances.js';

export interface MerchantRouteOptions {
  verifier: HumanAssertionVerifier;
  balances: BalanceService;
}

/**
 * Sandbox merchant balances. Merchants are shared demo fixtures, not a user's resources, so the
 * list is the same for every signed-in human; it carries no buyer or payment detail.
 */
export const merchantRoutes: FastifyPluginAsync<MerchantRouteOptions> = async (app, opts) => {
  const requireHuman = createRequireHuman(opts.verifier);
  app.decorateRequest('human', null);

  app.get('/human/merchants/balances', { preHandler: requireHuman('events:read') }, async () => ({
    items: await opts.balances.list(),
  }));
};
