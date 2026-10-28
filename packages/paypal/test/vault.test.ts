import { describe, expect, it } from 'vitest';
import type { PayPalContext } from '../src/client.js';
import { createVaultApi } from '../src/vault.js';

describe('createSetupToken', () => {
  it('asks PayPal for a new payment token per setup, even for a buyer it has vaulted before', async () => {
    const sent: unknown[] = [];
    const ctx = {
      vault: {
        createSetupToken: async (req: unknown) => {
          sent.push(req);
          return {} as never;
        },
      },
      exec: async (_op: unknown, run: () => Promise<unknown>) => {
        await run();
        return {
          raw: {
            id: 'SETUP-1',
            status: 'PAYER_ACTION_REQUIRED',
            links: [{ rel: 'approve', href: 'https://pp.test/approve' }],
          },
        };
      },
    } as unknown as PayPalContext;

    const res = await createVaultApi(ctx).createSetupToken({
      returnUrl: 'http://localhost:3000/onboarding/paypal/return',
      cancelUrl: 'http://localhost:3000/onboarding/paypal/return?cancelled=1',
      requestId: 'tk-setup-1',
    });

    expect(res).toEqual({
      id: 'SETUP-1',
      status: 'PAYER_ACTION_REQUIRED',
      approveUrl: 'https://pp.test/approve',
    });
    expect(sent).toEqual([
      expect.objectContaining({
        paypalRequestId: 'tk-setup-1',
        body: {
          paymentSource: {
            paypal: expect.objectContaining({ permitMultiplePaymentTokens: true }),
          },
        },
      }),
    ]);
  });
});
