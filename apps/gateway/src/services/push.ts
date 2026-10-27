import { formatUSD } from '@twokey/core';
import { approvals, type Db, merchants, payments, pushSubscriptions } from '@twokey/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import webpush from 'web-push';

type Logger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface PushSubscriptionKeys {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Sends one encrypted push; resolves with the push service's HTTP status. */
export type SendPush = (sub: PushSubscriptionKeys, payload: string) => Promise<number>;

export interface PushService {
  /** Pushes "Approve $X at Store?" to every device of the user. Never throws. */
  sendApprovalPush(userId: string, approvalId: string): Promise<void>;
}

export interface ApprovalPushPayload {
  title: string;
  body: string;
  url: string;
}

/** Push services browsers actually use. Anything else is refused, so the gateway never
 * posts to an address a user typed in (internal hosts included). */
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  'notify.windows.com',
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Pure: the notification text, from the held payment and its stored anomaly. */
export function approvalPushPayload(row: {
  approvalId: string;
  amountCents: number;
  merchant: string;
  reason: unknown;
}): ApprovalPushPayload {
  const r = row.reason as {
    expected?: { referenceCents?: unknown };
    actual?: { priceCents?: unknown };
  } | null;
  const ref = r?.expected?.referenceCents;
  const price = r?.actual?.priceCents;
  const why =
    typeof ref === 'number' && typeof price === 'number' && ref > 0
      ? `${Math.round((price / ref - 1) * 100)}% above the usual price.`
      : 'The price looks unusual.';
  return {
    title: `Approve ${formatUSD(row.amountCents)} at ${row.merchant}?`,
    body: `${why} Ignored holds are voided automatically.`,
    url: `/m/approve/${row.approvalId}`,
  };
}

export function webPushSender(vapid: VapidKeys): SendPush {
  const options = {
    vapidDetails: vapid,
    TTL: 15 * 60,
    urgency: 'high' as const,
    timeout: 10_000,
  };
  return async (sub, payload) => {
    try {
      const res = await webpush.sendNotification(sub, payload, options);
      return res.statusCode;
    } catch (err) {
      const status = (err as { statusCode?: unknown }).statusCode;
      if (typeof status === 'number') return status;
      throw err;
    }
  };
}

export function createPushService(deps: {
  db: Db;
  send: SendPush;
  log: Logger;
  now?: () => Date;
}): PushService {
  const { db, send, log } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    async sendApprovalPush(userId, approvalId) {
      try {
        const [row] = await db
          .select({
            approvalId: approvals.id,
            amountCents: payments.amountCents,
            merchant: merchants.displayName,
            reason: approvals.reason,
          })
          .from(approvals)
          .innerJoin(payments, eq(payments.id, approvals.paymentId))
          .innerJoin(merchants, eq(merchants.id, payments.payeeMerchantId))
          .where(and(eq(approvals.id, approvalId), eq(approvals.userId, userId)))
          .limit(1);
        if (!row) return;
        const payload = JSON.stringify(approvalPushPayload(row));
        const subs = await db
          .select()
          .from(pushSubscriptions)
          .where(eq(pushSubscriptions.userId, userId));
        let delivered = 0;
        for (const s of subs) {
          try {
            const status = await send(
              { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
              payload,
            );
            // The status only: endpoints and keys are never logged.
            log.info({ approvalId, pushStatus: status }, 'approval push result');
            if (status === 404 || status === 410) {
              // The browser dropped this subscription; forget it.
              await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
            } else if (status >= 200 && status < 300) {
              delivered++;
              await db
                .update(pushSubscriptions)
                .set({ lastOkAt: now() })
                .where(eq(pushSubscriptions.id, s.id));
            } else {
              log.warn({ approvalId, status }, 'push refused');
            }
          } catch (err) {
            log.warn({ approvalId, err: { message: (err as Error).message } }, 'push failed');
          }
        }
        log.info({ approvalId, devices: subs.length, delivered }, 'approval push sent');
      } catch (err) {
        // The inbox is the source of truth; a push problem never affects the hold.
        log.error({ approvalId, err: { message: (err as Error).message } }, 'approval push failed');
      }
    },
  };
}
