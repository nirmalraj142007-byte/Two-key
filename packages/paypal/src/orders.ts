import {
  CheckoutPaymentIntent,
  PaymentInitiator,
  StoredPaymentSourceUsageType,
  UsagePattern,
} from '@paypal/paypal-server-sdk';
import { AppError, ErrorCode, toPayPalValue } from '@twokey/core';
import type { PayPalContext } from './client.js';
import { first, obj, str } from './raw.js';

export interface VaultedAuthorizationInput {
  requestId: string;
  vaultId: string;
  payeeMerchantId?: string;
  referenceId: string;
  amountCents: number;
  item: { name: string; sku: string; qty: number; unitAmountCents: number };
}

export interface VaultedAuthorization {
  orderId: string;
  orderStatus: string;
  authorizationId: string;
  authorizationStatus: string;
  expirationTime?: string;
  raw: unknown;
}

export interface AuthorizationInfo {
  id: string;
  status: string;
  expirationTime?: string;
  raw: unknown;
}

export interface CaptureInfo {
  id: string;
  status: string;
  raw: unknown;
}

export interface OrdersApi {
  createVaultedAuthorization(i: VaultedAuthorizationInput): Promise<VaultedAuthorization>;
  capture(i: {
    authorizationId: string;
    requestId: string;
  }): Promise<{ captureId: string; status: string; raw: unknown }>;
  voidAuthorization(i: {
    authorizationId: string;
    requestId: string;
  }): Promise<{ status: 'VOIDED' }>;
  getAuthorization(id: string): Promise<AuthorizationInfo>;
  getCapture(id: string): Promise<CaptureInfo>;
}

const PREFER = 'return=representation';

/** The concept-killer signal: a vaulted order PayPal still wants the buyer to approve. */
export const PAYER_ACTION_MESSAGE = 'Vaulted order still needs payer action';

function authorizationOf(order: Record<string, unknown>) {
  const auth = first(obj(obj(first(order.purchase_units).payments)).authorizations);
  const expirationTime = str(auth.expiration_time);
  return {
    authorizationId: str(auth.id),
    authorizationStatus: str(auth.status),
    ...(expirationTime ? { expirationTime } : {}),
  };
}

export function createOrdersApi(ctx: PayPalContext): OrdersApi {
  return {
    async createVaultedAuthorization(i) {
      const { qty, unitAmountCents } = i.item;
      if (!Number.isSafeInteger(qty) || qty < 1 || qty * unitAmountCents !== i.amountCents) {
        throw new AppError(ErrorCode.VALIDATION, 'Order amount must equal qty × unit amount');
      }
      const value = toPayPalValue(i.amountCents);

      const created = await ctx.exec({ method: 'POST', path: '/v2/checkout/orders' }, () =>
        ctx.orders.createOrder({
          paypalRequestId: i.requestId,
          prefer: PREFER,
          body: {
            intent: CheckoutPaymentIntent.Authorize,
            purchaseUnits: [
              {
                referenceId: i.referenceId,
                customId: i.referenceId,
                invoiceId: `tk-${i.referenceId}`,
                amount: {
                  currencyCode: 'USD',
                  value,
                  breakdown: { itemTotal: { currencyCode: 'USD', value } },
                },
                items: [
                  {
                    name: i.item.name,
                    sku: i.item.sku,
                    quantity: String(qty),
                    unitAmount: { currencyCode: 'USD', value: toPayPalValue(unitAmountCents) },
                  },
                ],
                ...(i.payeeMerchantId ? { payee: { merchantId: i.payeeMerchantId } } : {}),
              },
            ],
            // Field set from the Orders v2 example "Create and authorize an order for a PayPal
            // wallet vaulted account": a merchant-initiated, subsequent use of a stored wallet.
            // Agent purchases are ad hoc, so the pattern is UNSCHEDULED_PREPAID.
            paymentSource: {
              paypal: {
                vaultId: i.vaultId,
                storedCredential: {
                  paymentInitiator: PaymentInitiator.Merchant,
                  usage: StoredPaymentSourceUsageType.Subsequent,
                  usagePattern: UsagePattern.UnscheduledPrepaid,
                },
              },
            },
          },
        }),
      );

      let order = created.raw;
      const orderId = str(order.id);
      let orderStatus = str(order.status);

      if (orderStatus === 'PAYER_ACTION_REQUIRED') {
        throw new AppError(ErrorCode.UPSTREAM_PAYPAL, PAYER_ACTION_MESSAGE, {
          details: { orderId },
        });
      }
      if (orderStatus === 'CREATED' || orderStatus === 'APPROVED') {
        const authorized = await ctx.exec(
          { method: 'POST', path: `/v2/checkout/orders/${orderId}/authorize` },
          () =>
            ctx.orders.authorizeOrder({
              id: orderId,
              paypalRequestId: `${i.requestId}-authorize`,
              prefer: PREFER,
            }),
        );
        order = authorized.raw;
        orderStatus = str(order.status);
      }
      if (orderStatus !== 'COMPLETED') {
        throw new AppError(ErrorCode.UPSTREAM_PAYPAL, `Unexpected order status ${orderStatus}`, {
          details: { orderId, orderStatus },
        });
      }

      const auth = authorizationOf(order);
      if (!auth.authorizationId) {
        throw new AppError(ErrorCode.UPSTREAM_PAYPAL, 'Completed order has no authorization', {
          details: { orderId },
        });
      }
      return { orderId, orderStatus, ...auth, raw: order };
    },

    async capture({ authorizationId, requestId }) {
      const { raw } = await ctx.exec(
        { method: 'POST', path: `/v2/payments/authorizations/${authorizationId}/capture` },
        () =>
          ctx.payments.captureAuthorizedPayment({
            authorizationId,
            paypalRequestId: requestId,
            prefer: PREFER,
            body: { finalCapture: true },
          }),
      );
      return { captureId: str(raw.id), status: str(raw.status), raw };
    },

    async voidAuthorization({ authorizationId, requestId }) {
      await ctx.exec(
        { method: 'POST', path: `/v2/payments/authorizations/${authorizationId}/void` },
        () => ctx.payments.voidPayment({ authorizationId, paypalRequestId: requestId }),
      );
      return { status: 'VOIDED' };
    },

    async getAuthorization(id) {
      const { raw } = await ctx.exec(
        { method: 'GET', path: `/v2/payments/authorizations/${id}` },
        () => ctx.payments.getAuthorizedPayment({ authorizationId: id }),
      );
      const expirationTime = str(raw.expiration_time);
      return {
        id: str(raw.id),
        status: str(raw.status),
        ...(expirationTime ? { expirationTime } : {}),
        raw,
      };
    },

    async getCapture(id) {
      const { raw } = await ctx.exec({ method: 'GET', path: `/v2/payments/captures/${id}` }, () =>
        ctx.payments.getCapturedPayment({ captureId: id }),
      );
      return { id: str(raw.id), status: str(raw.status), raw };
    },
  };
}
