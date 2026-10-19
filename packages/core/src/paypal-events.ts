/** Every webhook event type the gateway's PayPal subscription must include. */
export const REQUIRED_WEBHOOK_EVENTS = [
  'PAYMENT.AUTHORIZATION.CREATED',
  'PAYMENT.AUTHORIZATION.VOIDED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DENIED',
  'VAULT.PAYMENT-TOKEN.CREATED',
  'VAULT.PAYMENT-TOKEN.DELETED',
] as const;

/** Required events a subscription lacks. PayPal's `*` subscribes to every event. */
export function missingWebhookEvents(eventTypes: readonly string[]): string[] {
  if (eventTypes.includes('*')) return [];
  return REQUIRED_WEBHOOK_EVENTS.filter((e) => !eventTypes.includes(e));
}

/** The URL PayPal must deliver to for a gateway at `publicBaseUrl`. */
export function webhookUrlFor(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/webhooks/paypal`;
}
