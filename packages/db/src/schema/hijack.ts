import {
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { agentSessions } from './product.js';

export const hijackAttemptStatus = pgEnum('hijack_attempt_status', [
  'running',
  'done',
  'replayed',
  'failed',
]);

/**
 * One judge-written attack from the public hijack box. `injection_text` is untrusted: stored as
 * text, shown only as text, never sent to the rule compiler. Published as its own dataset.
 */
export const hijackAttempts = pgTable(
  'hijack_attempts',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    /** sha256(IP_HASH_SALT + ip); the address itself is never stored. */
    ipHash: text('ip_hash').notNull(),
    injectionText: text('injection_text').notNull(),
    model: text('model').notNull(),
    sessionId: uuid('session_id').references(() => agentSessions.id),
    status: hijackAttemptStatus('status').notNull(),
    /** 'live' when the agent ran; 'replay' when the daily caps were reached at submit time. */
    mode: text('mode').notNull(),
    outcome: jsonb('outcome'),
    /** Model tokens used by the live run (input + output); the daily token cap sums these. */
    tokens: integer('tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('hijack_attempts_ip_created').on(t.ipHash, t.createdAt),
    index('hijack_attempts_created').on(t.createdAt),
    index('hijack_attempts_session').on(t.sessionId),
  ],
);
