CREATE TYPE "public"."attack_source" AS ENUM('injecagent', 'agentdojo', 'judge_written');--> statement-breakpoint
CREATE TYPE "public"."eval_split" AS ENUM('dev', 'test');--> statement-breakpoint
CREATE TYPE "public"."eval_target_type" AS ENUM('outside_rules', 'inside_rules');--> statement-breakpoint
CREATE TYPE "public"."eval_variant" AS ENUM('clean', 'injecagent', 'agentdojo');--> statement-breakpoint
CREATE TABLE "attack_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" "attack_source" NOT NULL,
	"source_ref" text NOT NULL,
	"original_text" text NOT NULL,
	"adapted_text" text NOT NULL,
	"diff" text NOT NULL,
	"licence" text NOT NULL,
	CONSTRAINT "attack_templates_source_ref" UNIQUE("source","source_ref")
);
--> statement-breakpoint
CREATE TABLE "eval_episode_listings" (
	"episode_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "eval_episode_listings_episode_id_position_pk" PRIMARY KEY("episode_id","position")
);
--> statement-breakpoint
CREATE TABLE "eval_episodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"variant" "eval_variant" NOT NULL,
	"attack_template_id" uuid,
	"target_type" "eval_target_type",
	"target_listing_id" uuid,
	"injected_listing_id" uuid,
	"injection_position" integer,
	"target_fallback" boolean DEFAULT false NOT NULL,
	"frozen_tag" text,
	"content_sha256" text NOT NULL,
	CONSTRAINT "eval_episodes_task_variant" UNIQUE("task_id","variant")
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"episode_id" uuid NOT NULL,
	"model" text NOT NULL,
	"system_prompt_sha256" text NOT NULL,
	"temperature" real NOT NULL,
	"session_id" uuid,
	"followed_attack" boolean DEFAULT false NOT NULL,
	"honest_purchase_ok" boolean,
	"product_detail_ok" boolean,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_runs_episode_model" UNIQUE("episode_id","model")
);
--> statement-breakpoint
CREATE TABLE "eval_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"split" "eval_split" NOT NULL,
	"webshop_instruction_id" text NOT NULL,
	"instruction_text" text NOT NULL,
	"price_cap_cents" integer NOT NULL,
	"category" text NOT NULL,
	"goal_attrs" jsonb NOT NULL,
	"sample_seed" text NOT NULL,
	CONSTRAINT "eval_tasks_webshop_instruction_id_unique" UNIQUE("webshop_instruction_id")
);
--> statement-breakpoint
CREATE TABLE "predictions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"metric" text NOT NULL,
	"model" text,
	"gate" "gate",
	"predicted_low" numeric NOT NULL,
	"predicted_high" numeric NOT NULL,
	"registered_commit" text NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actual" numeric,
	"hit" boolean,
	CONSTRAINT "predictions_metric_model_gate" UNIQUE NULLS NOT DISTINCT("metric","model","gate")
);
--> statement-breakpoint
ALTER TABLE "eval_episode_listings" ADD CONSTRAINT "eval_episode_listings_episode_id_eval_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."eval_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_episode_listings" ADD CONSTRAINT "eval_episode_listings_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_episodes" ADD CONSTRAINT "eval_episodes_task_id_eval_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."eval_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_episodes" ADD CONSTRAINT "eval_episodes_attack_template_id_attack_templates_id_fk" FOREIGN KEY ("attack_template_id") REFERENCES "public"."attack_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_episodes" ADD CONSTRAINT "eval_episodes_target_listing_id_listings_id_fk" FOREIGN KEY ("target_listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_episodes" ADD CONSTRAINT "eval_episodes_injected_listing_id_listings_id_fk" FOREIGN KEY ("injected_listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_episode_id_eval_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."eval_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;