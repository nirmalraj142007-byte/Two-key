import type { PayPalCallEvent } from '@twokey/paypal';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * One registry per process (the PayPal client is per process too). Every label is drawn from a
 * small fixed set (outcomes, templated PayPal paths, PayPal event types), never from IDs.
 */
export const registry = new Registry();

export const decisionsTotal = new Counter({
  name: 'twokey_decisions_total',
  help: 'Gate decisions on agent proposals, by outcome (capture, hold, block, ask_every_time).',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const paypalRequestsTotal = new Counter({
  name: 'twokey_paypal_requests_total',
  help: 'PayPal REST calls by templated operation and HTTP status (0 = unreachable).',
  labelNames: ['op', 'status'] as const,
  registers: [registry],
});

export const webhookEventsTotal = new Counter({
  name: 'twokey_webhook_events_total',
  help: 'PayPal webhook deliveries by event type and signature verification result.',
  labelNames: ['type', 'verification'] as const,
  registers: [registry],
});

export const openAuthorizations = new Gauge({
  name: 'twokey_open_authorizations',
  help: 'Payments holding (or about to hold) an open PayPal authorization; refreshed every 30 s.',
  registers: [registry],
});

export const webhookLagSeconds = new Histogram({
  name: 'twokey_webhook_lag_seconds',
  help: "Seconds from PayPal's event create_time to the gateway receiving it.",
  buckets: [1, 5, 15, 30, 60, 120, 300, 900, 3600],
  registers: [registry],
});

export function recordPayPalCall(e: PayPalCallEvent): void {
  paypalRequestsTotal.inc({ op: e.op, status: String(e.status) });
}

/** received − create_time in seconds, or undefined when PayPal sent no usable create_time. */
export function webhookLag(createTime: unknown, receivedAt: Date): number | undefined {
  if (typeof createTime !== 'string') return undefined;
  const created = Date.parse(createTime);
  if (Number.isNaN(created)) return undefined;
  return Math.max(0, (receivedAt.getTime() - created) / 1000);
}
