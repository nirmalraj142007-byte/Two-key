import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const userRole = pgEnum('user_role', ['user', 'judge_demo', 'hijack_system']);
export const vaultTokenStatus = pgEnum('vault_token_status', ['active', 'deleted']);
export const merchantRole = pgEnum('merchant_role', ['allowed_demo', 'attacker', 'eval_merchant']);
export const snapshotKind = pgEnum('snapshot_kind', [
  'demo_unbranded',
  'eval_frozen',
  'live_cache',
  'hijack',
]);
export const ruleCardStatus = pgEnum('rule_card_status', ['draft', 'signed', 'revoked', 'expired']);
export const sessionMode = pgEnum('session_mode', ['live', 'demo', 'hijack', 'eval']);
export const sessionStatus = pgEnum('session_status', ['active', 'ended', 'failed']);
export const gate = pgEnum('gate', ['G0', 'G1', 'G2', 'G3', 'G4']);
export const gateOutcome = pgEnum('gate_outcome', ['capture', 'hold', 'block', 'ask_every_time']);

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash'),
  role: userRole('role').notNull().default('user'),
  createdAt: createdAt(),
});

export const vaultTokens = pgTable(
  'vault_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    paypalCustomerId: text('paypal_customer_id').notNull(),
    paymentTokenId: text('payment_token_id').notNull().unique(),
    status: vaultTokenStatus('status').notNull(),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('vault_tokens_one_active_per_user').on(t.userId).where(sql`${t.status} = 'active'`),
  ],
);

export const merchants = pgTable('merchants', {
  id: id(),
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull(),
  paypalMerchantId: text('paypal_merchant_id').unique(),
  paypalEmail: text('paypal_email'),
  role: merchantRole('role').notNull(),
  channel3WebsiteIds: text('channel3_website_ids').array().notNull().default(sql`'{}'::text[]`),
  reportingAppRef: text('reporting_app_ref'),
  createdAt: createdAt(),
});

export const catalogSnapshots = pgTable(
  'catalog_snapshots',
  {
    id: id(),
    kind: snapshotKind('kind').notNull(),
    frozenAt: timestamp('frozen_at', { withTimezone: true }).notNull().defaultNow(),
    contentSha256: text('content_sha256').notNull(),
    gitTag: text('git_tag'),
  },
  (t) => [unique('catalog_snapshots_kind_git_tag').on(t.kind, t.gitTag)],
);

/** `id` is the product_id the agent sees. */
export const listings = pgTable(
  'listings',
  {
    id: id(),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => catalogSnapshots.id),
    channel3ProductId: text('channel3_product_id'),
    groupKey: text('group_key').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    title: text('title').notNull(),
    brandName: text('brand_name'),
    category: text('category').notNull(),
    priceCents: integer('price_cents').notNull(),
    currency: text('currency').notNull().default('USD'),
    referencePriceCents: integer('reference_price_cents'),
    referenceNOffers: integer('reference_n_offers').notNull().default(0),
    structuredAttrs: jsonb('structured_attrs').notNull().default(sql`'{}'::jsonb`),
    description: text('description').notNull(),
    injectionId: uuid('injection_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('listings_snapshot_merchant').on(t.snapshotId, t.merchantId),
    index('listings_channel3_product').on(t.channel3ProductId),
    index('listings_snapshot_group').on(t.snapshotId, t.groupKey),
    // Seed upserts target this key.
    uniqueIndex('listings_snapshot_group_merchant').on(t.snapshotId, t.groupKey, t.merchantId),
  ],
);

export const ruleCards = pgTable(
  'rule_cards',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    version: integer('version').notNull(),
    status: ruleCardStatus('status').notNull(),
    nlRequest: text('nl_request').notNull(),
    rules: jsonb('rules').notNull(),
    enforcement: jsonb('enforcement').notNull(),
    compilerModel: text('compiler_model'),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    hmac: text('hmac'),
    keyId: text('key_id'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('rule_cards_user_version').on(t.userId, t.version),
    index('rule_cards_user_status').on(t.userId, t.status),
    check('rule_cards_signed_has_hmac', sql`${t.status} <> 'signed' OR ${t.hmac} IS NOT NULL`),
  ],
);

export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    ruleCardId: uuid('rule_card_id')
      .notNull()
      .references(() => ruleCards.id),
    mode: sessionMode('mode').notNull(),
    model: text('model').notNull(),
    agentTokenHash: text('agent_token_hash').notNull().unique(),
    status: sessionStatus('status').notNull().default('active'),
    transcript: jsonb('transcript').notNull().default(sql`'[]'::jsonb`),
    evalEpisodeId: uuid('eval_episode_id'),
    createdAt: createdAt(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [index('agent_sessions_user_created').on(t.userId, t.createdAt.desc())],
);

export const proposals = pgTable(
  'proposals',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => agentSessions.id),
    ruleCardId: uuid('rule_card_id')
      .notNull()
      .references(() => ruleCards.id),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id),
    qty: integer('qty').notNull(),
    idempotencyKey: text('idempotency_key'),
    rawToolArgs: jsonb('raw_tool_args').notNull(),
    agentReasoningExcerpt: text('agent_reasoning_excerpt'),
    resolvedAmountCents: integer('resolved_amount_cents').notNull(),
    resolvedMerchantId: uuid('resolved_merchant_id')
      .notNull()
      .references(() => merchants.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('proposals_session_idempotency').on(t.sessionId, t.idempotencyKey),
    index('proposals_session_created').on(t.sessionId, t.createdAt),
  ],
);

export const gateDecisions = pgTable(
  'gate_decisions',
  {
    id: id(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id),
    gate: gate('gate').notNull(),
    outcome: gateOutcome('outcome').notNull(),
    ruleHits: jsonb('rule_hits').notNull(),
    gateVersion: text('gate_version').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('gate_decisions_proposal_gate').on(t.proposalId, t.gate)],
);

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: createdAt(),
  lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
});

/** Daily LLM spend per scope; `spend()` in budget.ts is the only writer. */
export const budgetLedger = pgTable(
  'budget_ledger',
  {
    day: date('day').notNull(),
    scope: text('scope').notNull(),
    spentUsd: numeric('spent_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    capUsd: numeric('cap_usd', { precision: 12, scale: 6 }).notNull(),
    trippedAt: timestamp('tripped_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.day, t.scope] })],
);
