import { AppError, ErrorCode } from '@twokey/core';
import { webhookEvents } from '@twokey/db';
import type { VerifyWebhookSignature } from '@twokey/paypal';
import { ne, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { type Jobs, scheduleWebhookRetry } from '../jobs/queue.js';
import { applyWebhookEvent } from '../services/webhook-apply.js';

export interface WebhookRouteOptions {
  webhookId?: string | undefined;
  verify?: VerifyWebhookSignature | undefined;
  jobs?: Jobs | undefined;
}

// Only checks the envelope; the untouched raw body is what PayPal verifies and what we store.
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
  // PayPal signs the exact bytes it sent, so keep the body as a string. This plugin is
  // encapsulated, so the override applies to these routes only.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body),
  );

  app.post('/webhooks/paypal', async (req, reply) => {
    const { webhookId, verify } = opts;
    if (!webhookId || !verify || !app.hasDecorator('db')) {
      throw new AppError(ErrorCode.CONFIG_INVALID, 'webhook not configured', { httpStatus: 503 });
    }

    const rawBody = typeof req.body === 'string' ? req.body : '';
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new AppError(ErrorCode.VALIDATION, 'Webhook body must be JSON');
    }
    const parsed = envelope.safeParse(body);
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION, 'Webhook body needs id and event_type');
    }
    const meta = {
      eventId: parsed.data.id,
      eventType: parsed.data.event_type,
      resourceId: parsed.data.resource?.id ?? '',
    };

    let verification: 'SUCCESS' | 'FAILURE';
    try {
      verification = await verify({
        headers: stringHeaders(req.headers),
        rawBody,
        webhookId,
      });
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
      // Postgres parses the raw text itself (already checked as valid JSON above).
      raw: sql`${rawBody}::jsonb`,
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
          raw: sql`excluded.raw`,
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
    // Usually the API response that writes the payment row is a moment behind the webhook.
    if (result === 'no_payment' && opts.jobs)
      await scheduleWebhookRetry({ jobs: opts.jobs, log: req.log });
    return reply.send({ result });
  });
};
