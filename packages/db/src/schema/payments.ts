import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { merchants, proposals, users } from './product.js';

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

export const paymentState = pgEnum('payment_state', [
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
]);
export const paymentEventSource = pgEnum('payment_event_source', [
  'api_response',
  'webhook',
  'reconciler',
  'human',
  'timer',
]);
export const webhookVerification = pgEnum('webhook_verification', ['SUCCESS', 'FAILURE', 'ERROR']);
export const approvalStatus = pgEnum('approval_status', [
  'pending',
  'approved',
  'denied',
  'timed_out',
]);
export const approvalChannel = pgEnum('approval_channel', ['web', 'phone']);

export const payments = pgTable(
  'payments',
  {
    id: id(),
    proposalId: uuid('proposal_id')
      .notNull()
      .unique()
      .references(() => proposals.id),
    paypalOrderId: text('paypal_order_id').unique(),
    paypalAuthorizationId: text('paypal_authorization_id').unique(),
    paypalCaptureId: text('paypal_capture_id').unique(),
    payeeMerchantId: uuid('payee_merchant_id')
      .notNull()
      .references(() => merchants.id),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('USD'),
    state: paymentState('state').notNull(),
    honorExpiresAt: timestamp('honor_expires_at', { withTimezone: true }),
    authExpiresAt: timestamp('auth_expires_at', { withTimezone: true }),
    holdDeadlineAt: timestamp('hold_deadline_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('payments_state_hold_deadline').on(t.state, t.holdDeadlineAt)],
);

// Lives here, not in product.ts, so product.ts never imports payments.ts (no import cycle).
export const approvals = pgTable(
  'approvals',
  {
    id: id(),
    paymentId: uuid('payment_id')
      .notNull()
      .unique()
      .references(() => payments.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    status: approvalStatus('status').notNull(),
    reason: jsonb('reason').notNull(),
    explainerText: text('explainer_text'),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedVia: approvalChannel('decided_via'),
  },
  (t) => [index('approvals_user_pending').on(t.userId).where(sql`${t.status} = 'pending'`)],
);

export const paymentEvents = pgTable(
  'payment_events',
  {
    id: id(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id),
    source: paymentEventSource('source').notNull(),
    type: text('type').notNull(),
    fromState: paymentState('from_state'),
    toState: paymentState('to_state'),
    paypalEventId: text('paypal_event_id'),
    requestId: text('request_id'),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payment_events_payment_received').on(t.paymentId, t.receivedAt),
    uniqueIndex('payment_events_paypal_event_id')
      .on(t.paypalEventId)
      .where(sql`${t.paypalEventId} is not null`),
  ],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    paypalEventId: text('paypal_event_id').primaryKey(),
    eventType: text('event_type').notNull(),
    resourceId: text('resource_id').notNull(),
    verification: webhookVerification('verification').notNull(),
    raw: jsonb('raw').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    index('webhook_events_resource').on(t.resourceId),
    index('webhook_events_unprocessed').on(t.receivedAt).where(sql`${t.processedAt} is null`),
  ],
);
