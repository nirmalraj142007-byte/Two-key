# Deploying Two-Key

Staging is the Render Blueprint in `render.yaml`. It deploys from `main`. Production (from
`release`) is added in phase 30.

| Render service | Workspace | Health check (Render) | Notes |
| --- | --- | --- | --- |
| `gateway` | `@twokey/gateway` | `/healthz` | Runs migrations on start. `/healthz/deep` is for humans and uptime monitors |
| `web` | `@twokey/web` | `/api/healthz` | Next.js build at deploy time |
| `twokey-mcp` | `@twokey/mcp` | `/healthz` | |
| `agent-runner` | `@twokey/agent-runner` | `/healthz` | Web service, not a worker (free plan) |

Every service is on Render's **free** plan, and the database is an external **Neon** Postgres
(Render hosts no database).

## Free-tier limits (read this first)

- **Sleep.** A free web service spins down after 15 minutes with no inbound traffic and takes
  about a minute to wake on the next request. Whoever wakes it waits about a minute.
  - PayPal webhooks still arrive. The first delivery to a sleeping gateway may time out. PayPal
    then retries with back-off (for up to 3 days), so events can arrive late. They are never lost.
  - Background loops (the webhook retry loop now, pg-boss jobs such as hold timeouts from
    phase 9) **do not run while the gateway sleeps**. They catch up after it wakes.
  - Before a demo or judging window, wake every service by opening its `/healthz` URL.
- **Hours.** A workspace gets 750 free instance hours a month, shared by all services. Sleeping
  services use none. Keeping the gateway awake all month (an uptime monitor pinging it every
  10 minutes) uses about 744 hours, nearly the whole allowance. Only do that during judging.
- **No pre-deploy command.** Render offers `preDeployCommand` only on paid instances. The
  gateway's `startCommand` runs `npm run db:migrate -w @twokey/db` before starting. Migrations
  are forward-only and idempotent, so running them on every start is safe. If a migration fails,
  the new instance never becomes healthy and Render keeps the previous deploy live.
- **No shell or one-off jobs.** Run seeds and SQL from your machine against the Neon URL.

## 1. Create the Neon database (once)

1. <https://console.neon.tech> → **New project** → Postgres 16, region **AWS US West 2
   (Oregon)** to match Render's `oregon`.
2. Project dashboard → **Connect**. Turn **Connection pooling off** (you need the *direct*
   host, the one **without** `-pooler`). Copy the string. It looks like
   `postgresql://<user>:<password>@ep-xxxx.us-west-2.aws.neon.tech/<db>?sslmode=require`.
   Make sure it ends with `sslmode=require`.
3. Keep it in your password manager only. **Never commit it** or paste it into an issue or a doc.
   Locally, keep it as `STAGING_DATABASE_URL` in your shell, not in any `.env` file in the repo.

## 2. Create the Blueprint in Render

1. <https://dashboard.render.com> → **New +** (top right) → **Blueprint**.
2. **Connect a repository** → pick the Two-Key GitHub repo (grant Render access if asked).
3. **Blueprint Name**: `two-key-staging`. **Branch**: `main`. **Blueprint Path**: `render.yaml`.
4. Render lists the four services and asks for every `sync: false` variable. Fill them in
   from the table below (leave the ones marked *blank* empty), then click **Deploy Blueprint**.
5. The first gateway deploy may fail its webhook check. That's expected: `PAYPAL_WEBHOOK_ID`
   doesn't exist yet (step 3).

To change a value later: **Dashboard → service → Environment → Edit**, then
**Save, rebuild, and deploy** (or **Save and deploy**).

## Environment variables per service

Generate the values on your machine. Nothing below is committed.

### gateway

| Key | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `LOG_LEVEL` | `info` |
| `DATABASE_URL` | Neon **direct** connection string (`sslmode=require`) |
| `PAYPAL_ENV` | `sandbox` |
| `PAYPAL_CLIENT_ID` | PayPal developer dashboard → Apps & Credentials → Sandbox → your app |
| `PAYPAL_CLIENT_SECRET` | same app (gateway only) |
| `PAYPAL_WEBHOOK_ID` | *blank at first*; set in step 3 |
| `RULE_HMAC_KEY` | `openssl rand -base64 32` |
| `RULE_HMAC_KEY_ID` | `k1` |
| `HUMAN_ASSERTION_PUBLIC_KEY` | Ed25519 public key PEM (pair of web's private key) |
| `AGENT_TOKEN_PEPPER` | `openssl rand -base64 32` |
| `CHANNEL3_API_KEY` | *blank* until search lands |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | `npx web-push generate-vapid-keys` |
| `VAPID_SUBJECT` | *blank* until phase 18 |
| `WEB_ORIGIN` | `https://<web service>.onrender.com` |
| `PUBLIC_BASE_URL` | `https://<gateway service>.onrender.com` (no trailing slash) |
| `PORT` | *blank* (Render supplies `PORT`) |
| `MERCHANT_API_CREDENTIALS` | *blank* |
| `METRICS_TOKEN` | `openssl rand -hex 32` (gateway only; for `GET /metrics`, see OPERATIONS.md) |
| `MIGRATE_DATABASE_URL` | *blank* until the database roles are applied (below); then the owner's URL |

Never set `EVAL_ENABLED` or `EVAL_ADMIN_TOKEN` on Render: they are local-only, and the gateway
refuses to start with `EVAL_ENABLED=true` in production or on a service whose name ends in
`-prod`.

### web

| Key | Value |
| --- | --- |
| `NODE_ENV`, `LOG_LEVEL` | `production`, `info` |
| `DATABASE_URL` | the same Neon direct string |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `HUMAN_ASSERTION_PRIVATE_KEY` | Ed25519 private key PEM (web only) |
| `GATEWAY_URL` | `https://<gateway service>.onrender.com` |
| `ANTHROPIC_API_KEY` | your key |
| `IP_HASH_SALT` | `openssl rand -base64 16` |
| `HIJACK_DAILY_ATTEMPTS`, `HIJACK_DAILY_TOKENS` | *blank* (defaults 200 attempts and 400,000 tokens per UTC day) |
| `NEXT_PUBLIC_AG_GRID_LICENSE_KEY`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | *blank* for now |

### twokey-mcp

| Key | Value |
| --- | --- |
| `NODE_ENV`, `LOG_LEVEL` | `production`, `info` |
| `DATABASE_URL` | *blank* (mcp talks only to the gateway) |
| `GATEWAY_URL` | `https://<gateway service>.onrender.com` |
| `TWOKEY_AGENT_TOKEN`, `PORT` | *blank* |

### agent-runner

| Key | Value |
| --- | --- |
| `NODE_ENV`, `LOG_LEVEL` | `production`, `info` |
| `DATABASE_URL` | the same Neon direct string |
| `ANTHROPIC_API_KEY` | your key, or *blank* (only for claude-* models) |
| `AGENT_LLM_API_KEY` | your Groq key |
| `AGENT_LLM_BASE_URL`, `AGENT_MODEL` | *blank* (defaults) |
| `MCP_URL` | `https://<twokey-mcp service>.onrender.com` |
| `DAILY_BUDGET_USD_LIVE`, `HIJACK_DAILY_TOKENS`, `DEMO_EPISODE_ID`, `PORT` | *blank* (defaults) |

CI (`npm run check:secrets`) fails if `render.yaml` lists a secret on a service that may not hold
it. Every service also refuses to start if a secret is set where it doesn't belong.

## 3. Register the PayPal webhook

Run this locally. `.env.gateway` must hold the **same PayPal sandbox app** credentials as the
staging gateway, because PayPal verifies signatures per app.

```bash
npm run paypal:webhook -- --url https://<gateway service>.onrender.com
```

It finds the webhook for `<url>/webhooks/paypal`, creates it if absent, or resets its event types
to `REQUIRED_WEBHOOK_EVENTS` (`packages/core/src/paypal-events.ts`). It prints
`PAYPAL_WEBHOOK_ID=<id>`. Paste that id into **gateway → Environment → `PAYPAL_WEBHOOK_ID`** and
**Save and deploy**. Rerunning the script is safe.

## 4. Verify

```bash
curl -s https://<gateway service>.onrender.com/healthz
curl -s https://<gateway service>.onrender.com/healthz/deep
```

`/healthz` answers `{"ok":true,"service":"gateway",...,"commit":"<sha>"}` and never touches PayPal or
the DB, so a PayPal outage never restarts the gateway. `/healthz/deep` answers
`{"db":"ok","paypalAuth":"ok","webhookSubscriptions":"ok"}`. On any failure it returns HTTP 503
with the failing keys, and `missing` lists absent event types. PayPal results are cached for
60 seconds. Possible `webhookSubscriptions` values: `not_configured` (no `PAYPAL_WEBHOOK_ID`
or `PUBLIC_BASE_URL`), `not_found`, `wrong_url`, `missing_events`, `fail`.

Then make real sandbox events and check they landed:

```bash
npm run spike:vault -- --reuse
psql "$STAGING_DATABASE_URL" -c "select event_type, verification, received_at from webhook_events order by received_at desc limit 6"
```

If the gateway was asleep, allow a few minutes for PayPal's retries.

## Database roles (least privilege)

Until this is done every service connects as the Neon owner. `scripts/db-roles.sql` creates
one role per service: `twokey_gateway` (full DML, no DDL), `twokey_web` (reads all, writes
only what the web app writes, never payments, approvals or gate decisions) and
`twokey_runner`. It also creates `twokey_jobs`, a no-login role that owns pg-boss's schema.
SECURITY.md lists what each role may do; `packages/db/test/roles.test.ts` proves the denials.
Do this in phase 30, for staging first, then production:

1. **Back up.** Neon console → the project → **Branches** → create a branch from the current
   state (a free, instant copy to roll back to).
2. **Apply the script as the owner**, after the latest deploy has run its migrations and
   started once (that installs pg-boss's schema):

   ```bash
   psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db-roles.sql
   ```

   It is idempotent. Run it again after any migration that adds a table.
3. **Set the passwords**, one long random value per role, never committed:

   ```bash
   psql "$OWNER_DATABASE_URL" -c "alter role twokey_gateway password '<openssl rand -hex 24>'"
   psql "$OWNER_DATABASE_URL" -c "alter role twokey_web password '<…>'"
   psql "$OWNER_DATABASE_URL" -c "alter role twokey_runner password '<…>'"
   ```

   On Neon, roles made through SQL work like any other; the connection string is the owner's
   with the user and password swapped (keep the host, database and `sslmode=require`).
4. **Point each service at its role** (Render → service → **Environment**):

   | Service | `DATABASE_URL` user | Also |
   | --- | --- | --- |
   | gateway | `twokey_gateway` | `MIGRATE_DATABASE_URL` = the owner's URL: the start command runs migrations with it, then the gateway serves as `twokey_gateway` |
   | web | `twokey_web` | — |
   | agent-runner | `twokey_runner` | — |
   | twokey-mcp | *none* (it talks only to the gateway; remove `DATABASE_URL` if set) | — |

   **Save and deploy** the gateway first, then web and agent-runner.
5. **Verify**: `/healthz/deep` is 200; run one console purchase (captured), one blocked and
   one held then denied; check the agent-runner logs show `job.done`, and the web logs show no
   `permission denied`. A `permission denied for …` in any log names the missing grant; add it
   to the script (and the test), never connect as the owner to work around it.
6. **Roll back** by restoring each service's `DATABASE_URL` to the owner's URL (the roles can
   stay). Dropping the roles needs `drop owned by twokey_jobs` first.

## Rollback

**Dashboard → gateway (or another service) → Events** → find the last good deploy →
**Rollback**. Rolling back redeploys old code only. Migrations are forward-only and additive, so
older code keeps working on the newer schema. Never hand-edit the schema to "undo" a migration.
To stop a bad commit from redeploying, revert it on `main`, or turn off **Auto-Deploy** under
**Settings** first.
