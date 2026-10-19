CREATE TYPE "public"."approval_channel" AS ENUM('web', 'phone');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'denied', 'timed_out');--> statement-breakpoint
CREATE TYPE "public"."payment_event_source" AS ENUM('api_response', 'webhook', 'reconciler', 'human', 'timer');--> statement-breakpoint
CREATE TYPE "public"."payment_state" AS ENUM('authorizing', 'authorized', 'held', 'capture_requested', 'captured', 'void_requested', 'voided', 'expired', 'denied', 'failed');--> statement-breakpoint
CREATE TYPE "public"."webhook_verification" AS ENUM('SUCCESS', 'FAILURE', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."gate" AS ENUM('G0', 'G1', 'G2', 'G3', 'G4');--> statement-breakpoint
CREATE TYPE "public"."gate_outcome" AS ENUM('capture', 'hold', 'block', 'ask_every_time');--> statement-breakpoint
CREATE TYPE "public"."merchant_role" AS ENUM('allowed_demo', 'attacker', 'eval_merchant');--> statement-breakpoint
CREATE TYPE "public"."rule_card_status" AS ENUM('draft', 'signed', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."session_mode" AS ENUM('live', 'demo', 'hijack', 'eval');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('active', 'ended', 'failed');--> statement-breakpoint
CREATE TYPE "public"."snapshot_kind" AS ENUM('demo_unbranded', 'eval_frozen', 'live_cache', 'hijack');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'judge_demo', 'hijack_system');--> statement-breakpoint
CREATE TYPE "public"."vault_token_status" AS ENUM('active', 'deleted');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "approval_status" NOT NULL,
	"reason" jsonb NOT NULL,
	"explainer_text" text,
	"deadline_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_via" "approval_channel",
	CONSTRAINT "approvals_payment_id_unique" UNIQUE("payment_id")
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_id" uuid NOT NULL,
	"source" "payment_event_source" NOT NULL,
	"type" text NOT NULL,
	"from_state" "payment_state",
	"to_state" "payment_state",
	"paypal_event_id" text,
	"request_id" text,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"proposal_id" uuid NOT NULL,
	"paypal_order_id" text,
	"paypal_authorization_id" text,
	"paypal_capture_id" text,
	"payee_merchant_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"state" "payment_state" NOT NULL,
	"honor_expires_at" timestamp with time zone,
	"auth_expires_at" timestamp with time zone,
	"hold_deadline_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_proposal_id_unique" UNIQUE("proposal_id"),
	CONSTRAINT "payments_paypal_order_id_unique" UNIQUE("paypal_order_id"),
	CONSTRAINT "payments_paypal_authorization_id_unique" UNIQUE("paypal_authorization_id"),
	CONSTRAINT "payments_paypal_capture_id_unique" UNIQUE("paypal_capture_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"paypal_event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"verification" "webhook_verification" NOT NULL,
	"raw" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"rule_card_id" uuid NOT NULL,
	"mode" "session_mode" NOT NULL,
	"model" text NOT NULL,
	"agent_token_hash" text NOT NULL,
	"status" "session_status" DEFAULT 'active' NOT NULL,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"eval_episode_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "agent_sessions_agent_token_hash_unique" UNIQUE("agent_token_hash")
);
--> statement-breakpoint
CREATE TABLE "catalog_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "snapshot_kind" NOT NULL,
	"frozen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_sha256" text NOT NULL,
	"git_tag" text,
	CONSTRAINT "catalog_snapshots_kind_git_tag" UNIQUE("kind","git_tag")
);
--> statement-breakpoint
CREATE TABLE "gate_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"proposal_id" uuid NOT NULL,
	"gate" "gate" NOT NULL,
	"outcome" "gate_outcome" NOT NULL,
	"rule_hits" jsonb NOT NULL,
	"gate_version" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_decisions_proposal_gate" UNIQUE("proposal_id","gate")
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"channel3_product_id" text,
	"group_key" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"brand_name" text,
	"category" text NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"reference_price_cents" integer,
	"reference_n_offers" integer DEFAULT 0 NOT NULL,
	"structured_attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"description" text NOT NULL,
	"injection_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"paypal_merchant_id" text,
	"paypal_email" text,
	"role" "merchant_role" NOT NULL,
	"channel3_website_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"reporting_app_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "merchants_paypal_merchant_id_unique" UNIQUE("paypal_merchant_id")
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"rule_card_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"idempotency_key" text,
	"raw_tool_args" jsonb NOT NULL,
	"agent_reasoning_excerpt" text,
	"resolved_amount_cents" integer NOT NULL,
	"resolved_merchant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_session_idempotency" UNIQUE("session_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ok_at" timestamp with time zone,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "rule_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "rule_card_status" NOT NULL,
	"nl_request" text NOT NULL,
	"rules" jsonb NOT NULL,
	"enforcement" jsonb NOT NULL,
	"compiler_model" text,
	"signed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"hmac" text,
	"key_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_cards_user_version" UNIQUE("user_id","version"),
	CONSTRAINT "rule_cards_signed_has_hmac" CHECK ("rule_cards"."status" <> 'signed' OR "rule_cards"."hmac" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "vault_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"paypal_customer_id" text NOT NULL,
	"payment_token_id" text NOT NULL,
	"status" "vault_token_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "vault_tokens_payment_token_id_unique" UNIQUE("payment_token_id")
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payee_merchant_id_merchants_id_fk" FOREIGN KEY ("payee_merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_rule_card_id_rule_cards_id_fk" FOREIGN KEY ("rule_card_id") REFERENCES "public"."rule_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_snapshot_id_catalog_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."catalog_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_rule_card_id_rule_cards_id_fk" FOREIGN KEY ("rule_card_id") REFERENCES "public"."rule_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_resolved_merchant_id_merchants_id_fk" FOREIGN KEY ("resolved_merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_cards" ADD CONSTRAINT "rule_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_tokens" ADD CONSTRAINT "vault_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_user_pending" ON "approvals" USING btree ("user_id") WHERE "approvals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "payment_events_payment_received" ON "payment_events" USING btree ("payment_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_paypal_event_id" ON "payment_events" USING btree ("paypal_event_id") WHERE "payment_events"."paypal_event_id" is not null;--> statement-breakpoint
CREATE INDEX "payments_state_hold_deadline" ON "payments" USING btree ("state","hold_deadline_at");--> statement-breakpoint
CREATE INDEX "webhook_events_resource" ON "webhook_events" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed" ON "webhook_events" USING btree ("received_at") WHERE "webhook_events"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "agent_sessions_user_created" ON "agent_sessions" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "listings_snapshot_merchant" ON "listings" USING btree ("snapshot_id","merchant_id");--> statement-breakpoint
CREATE INDEX "listings_channel3_product" ON "listings" USING btree ("channel3_product_id");--> statement-breakpoint
CREATE INDEX "listings_snapshot_group" ON "listings" USING btree ("snapshot_id","group_key");--> statement-breakpoint
CREATE UNIQUE INDEX "listings_snapshot_group_merchant" ON "listings" USING btree ("snapshot_id","group_key","merchant_id");--> statement-breakpoint
CREATE INDEX "proposals_session_created" ON "proposals" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "rule_cards_user_status" ON "rule_cards" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_tokens_one_active_per_user" ON "vault_tokens" USING btree ("user_id") WHERE "vault_tokens"."status" = 'active';