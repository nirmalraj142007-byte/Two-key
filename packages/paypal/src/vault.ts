import {
  OrderApplicationContextShippingPreference,
  PaypalPaymentTokenCustomerType,
  PaypalPaymentTokenUsageType,
  VaultTokenRequestType,
} from '@paypal/paypal-server-sdk';
import { AppError, ErrorCode } from '@twokey/core';
import type { PayPalContext } from './client.js';
import { str } from './raw.js';

export interface VaultApi {
  createSetupToken(i: {
    returnUrl: string;
    cancelUrl: string;
    requestId: string;
  }): Promise<{ id: string; status: string; approveUrl: string }>;
  getSetupToken(id: string): Promise<{ id: string; status: string }>;
  createPaymentToken(i: {
    setupTokenId: string;
    requestId: string;
  }): Promise<{ paymentTokenId: string; customerId: string }>;
  deletePaymentToken(id: string): Promise<void>;
}

interface Link {
  href?: string;
  rel?: string;
}

export function createVaultApi(ctx: PayPalContext): VaultApi {
  return {
    async createSetupToken({ returnUrl, cancelUrl, requestId }) {
      const { raw } = await ctx.exec({ method: 'POST', path: '/v3/vault/setup-tokens' }, () =>
        ctx.vault.createSetupToken({
          paypalRequestId: requestId,
          body: {
            paymentSource: {
              paypal: {
                usageType: PaypalPaymentTokenUsageType.Merchant,
                customerType: PaypalPaymentTokenCustomerType.Consumer,
                // One buyer may save a separate wallet for each Two-Key user (judges share one
                // sandbox buyer; the hijack user has its own). Without this PayPal hands back the
                // buyer's existing token, which another user already holds.
                permitMultiplePaymentTokens: true,
                experienceContext: {
                  returnUrl,
                  cancelUrl,
                  brandName: 'Two-Key',
                  shippingPreference: OrderApplicationContextShippingPreference.NoShipping,
                },
              },
            },
          },
        }),
      );
      const links = (Array.isArray(raw.links) ? raw.links : []) as Link[];
      const approveUrl = links.find((l) => l.rel === 'approve')?.href;
      if (!approveUrl) {
        throw new AppError(ErrorCode.UPSTREAM_PAYPAL, 'Setup token has no approve link', {
          details: { setupTokenId: str(raw.id) },
        });
      }
      return { id: str(raw.id), status: str(raw.status), approveUrl };
    },

    async getSetupToken(id) {
      const { raw } = await ctx.exec({ method: 'GET', path: `/v3/vault/setup-tokens/${id}` }, () =>
        ctx.vault.getSetupToken(id),
      );
      return { id: str(raw.id), status: str(raw.status) };
    },

    async createPaymentToken({ setupTokenId, requestId }) {
      const { raw } = await ctx.exec({ method: 'POST', path: '/v3/vault/payment-tokens' }, () =>
        ctx.vault.createPaymentToken({
          paypalRequestId: requestId,
          body: {
            paymentSource: { token: { id: setupTokenId, type: VaultTokenRequestType.SetupToken } },
          },
        }),
      );
      const customer = raw.customer as { id?: unknown } | undefined;
      const paymentTokenId = str(raw.id);
      const customerId = str(customer?.id);
      if (!paymentTokenId) {
        throw new AppError(ErrorCode.UPSTREAM_PAYPAL, 'Payment token response has no id');
      }
      return { paymentTokenId, customerId };
    },

    async deletePaymentToken(id) {
      await ctx.exec({ method: 'DELETE', path: '/v3/vault/payment-tokens/{id}' }, () =>
        ctx.vault.deletePaymentToken(id),
      );
    },
  };
}
