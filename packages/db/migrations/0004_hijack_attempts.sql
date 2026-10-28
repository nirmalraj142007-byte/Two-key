CREATE TYPE "public"."hijack_attempt_status" AS ENUM('running', 'done', 'replayed', 'failed');--> statement-breakpoint
CREATE TABLE "hijack_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ip_hash" text NOT NULL,
	"injection_text" text NOT NULL,
	"model" text NOT NULL,
	"session_id" uuid,
	"status" "hijack_attempt_status" NOT NULL,
	"mode" text NOT NULL,
	"outcome" jsonb,
	"tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_snapshots" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "hijack_attempts" ADD CONSTRAINT "hijack_attempts_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hijack_attempts_ip_created" ON "hijack_attempts" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "hijack_attempts_created" ON "hijack_attempts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "hijack_attempts_session" ON "hijack_attempts" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "catalog_snapshots" ADD CONSTRAINT "catalog_snapshots_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_snapshots_session" ON "catalog_snapshots" USING btree ("session_id");