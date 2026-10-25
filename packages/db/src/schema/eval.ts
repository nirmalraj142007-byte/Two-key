import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { agentSessions, gate, listings } from './product.js';

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

export const evalSplit = pgEnum('eval_split', ['dev', 'test']);
export const attackSource = pgEnum('attack_source', ['injecagent', 'agentdojo', 'judge_written']);
export const evalVariant = pgEnum('eval_variant', ['clean', 'injecagent', 'agentdojo']);
export const evalTargetType = pgEnum('eval_target_type', ['outside_rules', 'inside_rules']);

export const evalTasks = pgTable('eval_tasks', {
  id: id(),
  split: evalSplit('split').notNull(),
  webshopInstructionId: text('webshop_instruction_id').notNull().unique(),
  instructionText: text('instruction_text').notNull(),
  priceCapCents: integer('price_cap_cents').notNull(),
  category: text('category').notNull(),
  /** Includes the cap draw (base price, price range, sample) and `evalCard`. */
  goalAttrs: jsonb('goal_attrs').notNull(),
  sampleSeed: text('sample_seed').notNull(),
});

export const attackTemplates = pgTable(
  'attack_templates',
  {
    id: id(),
    source: attackSource('source').notNull(),
    /** File + case id + commit. */
    sourceRef: text('source_ref').notNull(),
    originalText: text('original_text').notNull(),
    /** The template with only the goal replaced; {title}, {productId} and {storeName} are filled per episode. */
    adaptedText: text('adapted_text').notNull(),
    diff: text('diff').notNull(),
    licence: text('licence').notNull(),
  },
  (t) => [unique('attack_templates_source_ref').on(t.source, t.sourceRef)],
);

export const evalEpisodes = pgTable(
  'eval_episodes',
  {
    id: id(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => evalTasks.id),
    variant: evalVariant('variant').notNull(),
    attackTemplateId: uuid('attack_template_id').references(() => attackTemplates.id),
    targetType: evalTargetType('target_type'),
    targetListingId: uuid('target_listing_id').references(() => listings.id),
    injectedListingId: uuid('injected_listing_id').references(() => listings.id),
    injectionPosition: integer('injection_position'),
    targetFallback: boolean('target_fallback').notNull().default(false),
    frozenTag: text('frozen_tag'),
    contentSha256: text('content_sha256').notNull(),
  },
  (t) => [unique('eval_episodes_task_variant').on(t.taskId, t.variant)],
);

export const evalEpisodeListings = pgTable(
  'eval_episode_listings',
  {
    episodeId: uuid('episode_id')
      .notNull()
      .references(() => evalEpisodes.id),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id),
    position: integer('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.episodeId, t.position] })],
);

export const evalRuns = pgTable(
  'eval_runs',
  {
    id: id(),
    episodeId: uuid('episode_id')
      .notNull()
      .references(() => evalEpisodes.id),
    model: text('model').notNull(),
    systemPromptSha256: text('system_prompt_sha256').notNull(),
    temperature: real('temperature').notNull(),
    sessionId: uuid('session_id').references(() => agentSessions.id),
    followedAttack: boolean('followed_attack').notNull().default(false),
    honestPurchaseOk: boolean('honest_purchase_ok'),
    /** LLM-graded. */
    productDetailOk: boolean('product_detail_ok'),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('eval_runs_episode_model').on(t.episodeId, t.model)],
);

export const predictions = pgTable(
  'predictions',
  {
    id: id(),
    metric: text('metric').notNull(),
    model: text('model'),
    gate: gate('gate'),
    predictedLow: numeric('predicted_low').notNull(),
    predictedHigh: numeric('predicted_high').notNull(),
    registeredCommit: text('registered_commit').notNull(),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
    actual: numeric('actual'),
    hit: boolean('hit'),
  },
  // model and gate may be null; NULLS NOT DISTINCT keeps one prediction per (metric, model, gate).
  (t) => [unique('predictions_metric_model_gate').on(t.metric, t.model, t.gate).nullsNotDistinct()],
);
