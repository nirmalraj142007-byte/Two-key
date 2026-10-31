-- Two-Key database least privilege.
--
-- Three login roles, one per service that talks to Postgres. Run it as the database owner (the
-- role that runs migrations, e.g. neondb_owner on Neon) AFTER migrations, and again after any
-- migration that adds a table. It is idempotent. Passwords are set separately (docs/DEPLOY.md),
-- never in this file. The owner role itself keeps running migrations; no service connects as it.
--
--   twokey_gateway  full DML on every table (the only service that moves payments)
--   twokey_web      reads everything; writes only what the web app writes: users, draft rule
--                   cards, push subscriptions, hijack attempts, ending its own console sessions,
--                   the compiler's budget ledger. Never payments, approvals or gate decisions.
--   twokey_runner   reads everything; writes transcripts and session status, the reasoning
--                   excerpt on proposals, budget_ledger and hijack attempts.
-- All three use pg-boss (schema pgboss) for jobs.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'twokey_gateway') THEN
    CREATE ROLE twokey_gateway LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'twokey_web') THEN
    CREATE ROLE twokey_web LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'twokey_runner') THEN
    CREATE ROLE twokey_runner LOGIN;
  END IF;
END
$$;

-- Start from nothing on every run, so a grant removed here is also removed in the database.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM twokey_gateway, twokey_web, twokey_runner;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM twokey_gateway, twokey_web, twokey_runner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO twokey_gateway, twokey_web, twokey_runner;

-- ---- gateway: full DML ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO twokey_gateway;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO twokey_gateway;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO twokey_gateway;

-- ---- web ------------------------------------------------------------------------------------
GRANT SELECT ON ALL TABLES IN SCHEMA public TO twokey_web;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO twokey_web;
GRANT INSERT, UPDATE ON users TO twokey_web;
GRANT INSERT, UPDATE ON rule_cards TO twokey_web;          -- drafts only: see the policy below
GRANT INSERT, UPDATE, DELETE ON push_subscriptions TO twokey_web;
GRANT INSERT, UPDATE ON hijack_attempts TO twokey_web;
GRANT UPDATE (status, ended_at) ON agent_sessions TO twokey_web;  -- ends its old console sessions
GRANT INSERT, UPDATE ON budget_ledger TO twokey_web;       -- the rule compiler's spend

-- ---- agent runner ---------------------------------------------------------------------------
GRANT SELECT ON ALL TABLES IN SCHEMA public TO twokey_runner;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO twokey_runner;
GRANT UPDATE (transcript, status, ended_at) ON agent_sessions TO twokey_runner;
GRANT UPDATE (agent_reasoning_excerpt) ON proposals TO twokey_runner;
GRANT INSERT, UPDATE ON budget_ledger TO twokey_runner;
GRANT UPDATE ON hijack_attempts TO twokey_runner;

-- ---- rule cards: web may only write drafts ---------------------------------------------------
-- Row-level security binds the roles above; the table owner (migrations) is not affected.
-- Signing (draft -> signed, with the HMAC) is the gateway's alone.
ALTER TABLE rule_cards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rule_cards_gateway ON rule_cards;
CREATE POLICY rule_cards_gateway ON rule_cards TO twokey_gateway USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS rule_cards_read ON rule_cards;
CREATE POLICY rule_cards_read ON rule_cards FOR SELECT TO twokey_web, twokey_runner USING (true);
DROP POLICY IF EXISTS rule_cards_web_insert ON rule_cards;
CREATE POLICY rule_cards_web_insert ON rule_cards FOR INSERT TO twokey_web
  WITH CHECK (status = 'draft' AND hmac IS NULL AND signed_at IS NULL);
DROP POLICY IF EXISTS rule_cards_web_update ON rule_cards;
CREATE POLICY rule_cards_web_update ON rule_cards FOR UPDATE TO twokey_web
  USING (status = 'draft')
  WITH CHECK (status = 'draft' AND hmac IS NULL AND signed_at IS NULL);

-- ---- web's sign-in and hijack rate limiter (rate-limiter-flexible) ----------------------------
-- Created here so the web role never needs CREATE on the schema. Same shape the library makes.
CREATE TABLE IF NOT EXISTS hijack_rate_limits (
  key varchar(255) PRIMARY KEY,
  points integer NOT NULL DEFAULT 0,
  expire bigint
);
GRANT SELECT, INSERT, UPDATE, DELETE ON hijack_rate_limits TO twokey_web;

-- ---- pg-boss --------------------------------------------------------------------------------
-- pg-boss runs its own maintenance (it adds partitions to its stats table, and installs or
-- upgrades its schema on start), which needs owner rights inside schema pgboss. So pgboss
-- belongs to twokey_jobs, a no-login role the gateway and the runner (the two that work and
-- supervise jobs) are members of. It owns nothing in public. The web app only sends jobs
-- (supervise and schedule off), so it gets plain DML there and cannot drop or alter anything.
-- Install pg-boss first (the existing deployment, or one gateway start as the owner).
DO $$
DECLARE r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'twokey_jobs') THEN
    CREATE ROLE twokey_jobs NOLOGIN;
  END IF;
  -- The role running this script must be able to act as twokey_jobs to hand objects to it.
  EXECUTE format('GRANT twokey_jobs TO %I', current_user);
  GRANT twokey_jobs TO twokey_gateway, twokey_runner;
  REVOKE twokey_jobs FROM twokey_web;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') THEN
    CREATE SCHEMA pgboss;
  END IF;
  EXECUTE 'ALTER SCHEMA pgboss OWNER TO twokey_jobs';
  FOR r IN
    SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'pgboss' AND c.relkind IN ('r', 'p', 'S', 'v')
  LOOP
    EXECUTE format('ALTER %s pgboss.%I OWNER TO twokey_jobs',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' ELSE 'TABLE' END, r.relname);
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pgboss'
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO twokey_jobs', r.sig);
  END LOOP;
  FOR r IN
    SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'pgboss' AND t.typtype = 'e'
  LOOP
    EXECUTE format('ALTER TYPE pgboss.%I OWNER TO twokey_jobs', r.typname);
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA pgboss TO twokey_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO twokey_web;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA pgboss TO twokey_web;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO twokey_web;
-- Partitions and tables pg-boss adds later (owned by twokey_jobs) reach web too.
ALTER DEFAULT PRIVILEGES FOR ROLE twokey_jobs IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO twokey_web;
ALTER DEFAULT PRIVILEGES FOR ROLE twokey_jobs IN SCHEMA pgboss
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO twokey_web;
