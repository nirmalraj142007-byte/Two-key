export type PaymentState =
  | 'authorizing'
  | 'authorized'
  | 'held'
  | 'capture_requested'
  | 'captured'
  | 'void_requested'
  | 'voided'
  | 'expired'
  | 'denied'
  | 'failed';

export const PAYMENT_STATES: readonly PaymentState[] = [
  'authorizing',
  'authorized',
  'held',
  'capture_requested',
  'captured',
  'void_requested',
  'voided',
  'expired',
  'denied',
  'failed',
];

export const TERMINAL: ReadonlySet<PaymentState> = new Set<PaymentState>([
  'captured',
  'voided',
  'expired',
  'denied',
  'failed',
]);

/** Forward-only transitions. Anything not listed is invalid; terminal states have no exits. */
const TRANSITIONS: Readonly<Partial<Record<PaymentState, readonly PaymentState[]>>> = {
  authorizing: ['authorized', 'held', 'failed', 'voided', 'captured'],
  authorized: ['held', 'capture_requested', 'captured', 'void_requested', 'voided', 'expired'],
  held: ['capture_requested', 'captured', 'void_requested', 'voided', 'expired'],
  capture_requested: ['captured', 'denied', 'failed'],
  void_requested: ['voided'],
};

export function canTransition(from: PaymentState, to: PaymentState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

const WEBHOOK_TARGETS: Readonly<Record<string, PaymentState>> = {
  'PAYMENT.AUTHORIZATION.CREATED': 'authorized',
  'PAYMENT.AUTHORIZATION.VOIDED': 'voided',
  'PAYMENT.CAPTURE.COMPLETED': 'captured',
  'PAYMENT.CAPTURE.PENDING': 'capture_requested',
  'PAYMENT.CAPTURE.DENIED': 'denied',
};

/** The payment state a PayPal webhook event moves to; null for VAULT.* and unknown types. */
export function webhookTarget(eventType: string): PaymentState | null {
  return Object.hasOwn(WEBHOOK_TARGETS, eventType) ? (WEBHOOK_TARGETS[eventType] ?? null) : null;
}
