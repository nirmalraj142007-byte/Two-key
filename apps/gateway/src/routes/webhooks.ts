import { AppError, ErrorCode } from '@twokey/core';
import { webhookEvents } from '@twokey/db';
import type { VerifyWebhookSignature } from '@twokey/paypal';
import { ne, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { applyWebhookEvent } from '../services/webhook-apply.js';

export interface WebhookRouteOptions {
  webhookId?: string | undefined;
  verify?: VerifyWebhookSignature | undefined;
}

// Only checks the envelope; the untouched body is what PayPal verifies and what we store.
const envelope = z.looseObject({
  id: z.string().min(1),
  event_type: z.string().min(1),
  resource: z.looseObject({ id: z.string().optional() }).optional(),
});

function stringHeaders(headers: Record<string, string | string[] | undefined>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (typeof v === 'string') out[k] = v;
  return out;
}

/**
 * POST /webhooks/paypal. Verification and the DB write happen inline; no other PayPal
 * endpoint is ever called here, so we answer well inside PayPal's delivery timeout.
 */
export const webhookRoutes: FastifyPluginAsync<WebhookRouteOptions> = async (app, opts) => {
  app.post('/webhooks/paypal', async (req, reply) => {
    const { webhookId, verify } = opts;
    if (!webhookId || !verify || !app.hasDecorator('db')) {
      throw new AppError(ErrorCode.CONFIG_INVALID, 'webhook not configured', { httpStatus: 503 });
    }

    const parsed = envelope.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION, 'Webhook body needs id and event_type');
    }
    const event = req.body as Record<string, unknown>;
    const meta = {
      eventId: parsed.data.id,
      eventType: parsed.data.event_type,
      resourceId: parsed.data.resource?.id ?? '',
    };

    let verification: 'SUCCESS' | 'FAILURE';
    try {
      verification = await verify({ headers: stringHeaders(req.headers), event, webhookId });
    } catch (err) {
      req.log.warn({ ...meta, err }, 'paypal webhook verification unavailable');
      throw new AppError(ErrorCode.UPSTREAM_PAYPAL, 'Webhook verification unavailable, retry', {
        httpStatus: 503,
        retryable: true,
      });
    }

    const row = {
      paypalEventId: meta.eventId,
      eventType: meta.eventType,
      resourceId: meta.resourceId,
      verification,
      raw: event,
    };

    if (verification === 'FAILURE') {
      // Recorded for audit, never applied, and never overwrites a verified row.
      await app.db.insert(webhookEvents).values(row).onConflictDoNothing();
      req.log.warn(meta, 'paypal webhook failed verification');
      throw new AppError(ErrorCode.WEBHOOK_UNVERIFIED, 'Webhook signature not verified');
    }

    // A forged event may have claimed this ID first; a verified delivery replaces it.
    const [inserted] = await app.db
      .insert(webhookEvents)
      .values(row)
      .onConflictDoUpdate({
        target: webhookEvents.paypalEventId,
        set: {
          eventType: row.eventType,
          resourceId: row.resourceId,
          verification: 'SUCCESS',
          raw: row.raw,
          receivedAt: sql`now()`,
        },
        setWhere: ne(webhookEvents.verification, 'SUCCESS'),
      })
      .returning();

    if (!inserted) {
      req.log.info(meta, 'paypal webhook duplicate');
      return reply.send({ duplicate: true });
    }

    const result = await applyWebhookEvent(app.db, inserted);
    req.log.info({ ...meta, result }, 'paypal webhook received');
    return reply.send({ result });
  });
};
