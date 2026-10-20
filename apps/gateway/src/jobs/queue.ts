import type { Db } from '@twokey/db';
import type { OrdersApi } from '@twokey/paypal';
import type { FastifyBaseLogger } from 'fastify';

export const QUEUES = {
  holdTimeout: 'hold.timeout',
  reconcile: 'payment.reconcile',
  webhookPending: 'webhook.pending',
  sweep: 'sweep.open-auths',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export type Logger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

export interface SendOptions {
  startAfter?: Date | number;
  singletonKey?: string;
}

/** The only thing services need from the queue. Tests pass a recorder. */
export interface Jobs {
  send(name: QueueName, data: Record<string, unknown>, opts?: SendOptions): Promise<void>;
}

/** Everything the job handlers and the settle service need. */
export interface JobDeps {
  db: Db;
  paypal: Pick<OrdersApi, 'capture' | 'voidAuthorization' | 'getAuthorization' | 'getCapture'>;
  jobs: Jobs;
  log: Logger;
  now?: () => Date;
}

export const RECONCILE_DELAY_S = 30;
const WEBHOOK_RETRY_DELAY_S = 5;

/** Sends without failing the caller: the state is already persisted and the sweep is the backstop. */
export async function sendSafely(
  deps: Pick<JobDeps, 'jobs' | 'log'>,
  name: QueueName,
  data: Record<string, unknown>,
  opts?: SendOptions,
): Promise<void> {
  try {
    await deps.jobs.send(name, data, opts);
  } catch (err) {
    deps.log.error({ ...data, queue: name, err }, 'job send failed');
  }
}

export function scheduleReconcile(deps: Pick<JobDeps, 'jobs' | 'log'>, paymentId: string) {
  return sendSafely(
    deps,
    QUEUES.reconcile,
    { paymentId },
    { startAfter: RECONCILE_DELAY_S, singletonKey: paymentId },
  );
}

/** A verified webhook whose payment row is not written yet: look again in a few seconds. */
export function scheduleWebhookRetry(deps: Pick<JobDeps, 'jobs' | 'log'>) {
  return sendSafely(
    deps,
    QUEUES.webhookPending,
    {},
    { startAfter: WEBHOOK_RETRY_DELAY_S, singletonKey: 'pending' },
  );
}

/** One timer per hold, firing at its deadline. */
export function scheduleHoldTimeout(
  deps: Pick<JobDeps, 'jobs' | 'log'>,
  paymentId: string,
  deadline: Date,
) {
  return sendSafely(
    deps,
    QUEUES.holdTimeout,
    { paymentId },
    { startAfter: deadline, singletonKey: paymentId },
  );
}
