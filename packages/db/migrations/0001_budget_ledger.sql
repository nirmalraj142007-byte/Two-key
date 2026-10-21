CREATE TABLE "budget_ledger" (
	"day" date NOT NULL,
	"scope" text NOT NULL,
	"spent_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"cap_usd" numeric(12, 6) NOT NULL,
	"tripped_at" timestamp with time zone,
	CONSTRAINT "budget_ledger_day_scope_pk" PRIMARY KEY("day","scope")
);
