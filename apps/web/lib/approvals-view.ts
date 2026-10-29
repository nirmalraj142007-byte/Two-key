import { z } from 'zod';
import { PAYMENT_STATES } from './console-view';

/** One hold as GET /human/approvals[/:id] returns it. */
export const ApprovalItemSchema = z.object({
  id: z.string(),
  status: z.enum(['pending', 'approved', 'denied', 'timed_out']),
  deadlineAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedVia: z.enum(['web', 'phone', 'timer']).nullable(),
  paymentId: z.string(),
  state: z.enum(PAYMENT_STATES),
  amountCents: z.number().int(),
  amount: z.string(),
  proposalId: z.string(),
  qty: z.number().int(),
  product: z.string(),
  merchant: z.string(),
  referencePrice: z.string().nullable(),
  referenceOffers: z.number().int().nullable(),
  ratio: z.number().nullable(),
});
export type ApprovalItem = z.infer<typeof ApprovalItemSchema>;
export type ApprovalState = ApprovalItem['state'];

/** "40% above the usual price of $46.00 (3 stores)", from structured fields only. */
export function priceLine(
  item: Pick<ApprovalItem, 'ratio' | 'referencePrice' | 'referenceOffers'>,
): string {
  if (item.ratio === null || item.referencePrice === null) return 'The price looks unusual.';
  const pct = Math.round((item.ratio - 1) * 100);
  const where = item.referenceOffers !== null ? ` (${item.referenceOffers} stores)` : '';
  return `${pct}% above the usual price of ${item.referencePrice}${where}`;
}

const URGENT_MS = 10 * 60 * 1000;

/** Under 10 minutes from its deadline, a hold needs attention soon. */
export function isUrgent(deadlineAt: string, now: number): boolean {
  const left = new Date(deadlineAt).getTime() - now;
  return left > 0 && left < URGENT_MS;
}

/** True while the person can still approve or deny. */
export function isOpen(item: Pick<ApprovalItem, 'status' | 'state'>): boolean {
  return item.status === 'pending' && item.state === 'held';
}

/** The one sentence a decided or closed hold shows. */
export function outcomeSentence(state: ApprovalState): string {
  switch (state) {
    case 'captured':
      return 'Approved. PayPal captured the payment.';
    case 'capture_requested':
      return 'Approved. Capturing with PayPal…';
    case 'voided':
    case 'denied':
      return 'Voided. No charge was made.';
    case 'void_requested':
      return 'Voiding with PayPal… No charge will be made.';
    case 'expired':
      return 'This hold expired. No charge was made.';
    case 'failed':
      return 'Not purchased. No charge was made.';
    default:
      return 'Waiting for your decision.';
  }
}

const WHERE = { web: 'on the web', phone: 'on your phone' } as const;

/**
 * The sentence a closed hold shows, with the time it closed when known: "This hold was voided
 * at 10:42. No charge was made.", or "Already approved on the web at 10:42. ..." when it was
 * decided on the other screen. `time` formats an ISO timestamp as HH:MM.
 */
export function closedSentence(
  item: Pick<ApprovalItem, 'status' | 'decidedAt' | 'decidedVia'>,
  state: ApprovalState,
  via: 'web' | 'phone',
  time: (iso: string) => string,
): string {
  const at = item.decidedAt ? time(item.decidedAt) : null;
  const by = item.decidedVia;
  if (at && by && by !== 'timer' && by !== via && item.status !== 'pending') {
    const verb = item.status === 'approved' ? 'approved' : 'denied';
    const tail =
      state === 'captured'
        ? 'PayPal captured the payment.'
        : state === 'capture_requested'
          ? 'Capturing with PayPal…'
          : 'No charge was made.';
    return `Already ${verb} ${WHERE[by]} at ${at}. ${tail}`;
  }
  if (at && (state === 'voided' || state === 'denied')) {
    return `This hold was voided at ${at}. No charge was made.`;
  }
  if (at && state === 'expired') return `This hold expired at ${at}. No charge was made.`;
  return outcomeSentence(state);
}

/** The VAPID public key (base64url) as the bytes PushManager wants. */
export function urlBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** True when a subscription's applicationServerKey is exactly this VAPID key. */
export function sameKey(current: ArrayBuffer | null | undefined, key: Uint8Array): boolean {
  if (!current) return false;
  const a = new Uint8Array(current);
  return a.length === key.length && a.every((b, i) => b === key[i]);
}

/** A usable VAPID public key: base64url of a 65-byte uncompressed P-256 point. */
export function isValidVapidKey(key: string | null | undefined): key is string {
  if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) return false;
  try {
    const bytes = urlBase64ToBytes(key);
    return bytes.length === 65 && bytes[0] === 4;
  } catch {
    return false;
  }
}
