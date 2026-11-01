# Deploying Two-Key

Two-Key has **one public environment: production.** It is the Render Blueprint in `render.yaml`
(four services) on one external **Neon** Postgres database. Every service deploys from the
**`release`** branch. `main` no longer deploys the live site: `scripts/release.sh` fast-forwards
`release` to a `main` commit that has passed `npm run check` and a local smoke run.

| Render service | Workspace | Health check (Render) | Notes |
| --- | --- | --- | --- |
| `gateway` | `@twokey/gateway` | `/healthz` | Runs migrations at the start of its start command. `/healthz/deep` is for humans and uptime monitors |
| `web` | `@twokey/web` | `/api/healthz` | Next.js build at deploy time |
| `twokey-mcp` | `@twokey/mcp` | `/healthz` | Streamable HTTP at `/mcp` |
| `agent-runner` | `@twokey/agent-runner` | `/healthz` | Web service, not a worker |

**Instance plan** (`plan:` in `render.yaml`; `check:secrets` accepts `free` or `starter`):

| Dates | Plan | Why |
| --- | --- | --- |
| until Nov 8 | `free` | Free services sleep after 15 minutes idle and take about a minute to wake |
| Nov 8 → Dec 16 | `starter` | Judging: no sleep. Switch with one commit changing the four `plan:` lines, released as usual |
| from Dec 16 | `free` | Downgrade after judging, the same way |

On both plans the gateway's start command runs `npm run db:migrate -w @twokey/db` before it
serves (Render runs a `preDeployCommand` only on paid instances, so none is used). If a
migration fails, the new instance never becomes healthy and the previous deploy stays live. Render hosts no database; there are no `-prod` duplicates and no
separate staging services. Before any change goes live it runs locally (`npm run dev`) and in CI.

## How a change reaches the live site

1. Merge to `main`; CI must be green.
2. Check out that commit, start the dev stack (`npm run dev`, ports 3000/4000/4100/4200; never the
   evaluation stack's 4010/4110/4210), then:

   ```bash
   SMOKE_AGENT_TOKEN=tk_agent_... bash scripts/release.sh <commit>
   ```

   It refuses a dirty tree, a commit that isn't on `origin/main` or isn't checked out, and
   anything that is not a fast-forward of `origin/release`. It runs `npm run check` and
   `npm run smoke -- --env local`, pushes `<commit>` to `release`, and prints the rollback steps.
3. Render auto-deploys the four services from `release`. Wait for **Deploy live** on each.
4. `npm run smoke -- --env prod` (below).

## Migrations policy

- **Forward-only.** There are no down migrations. A rollback never needs one.
- **Additive after Nov 4 (feature freeze).** New tables, new nullable columns or columns with
  defaults, new indexes. No drops, renames or type changes, and no new `NOT NULL` without a
  default. So the previous release's code always runs on the newer schema, which is what makes a
  code-only rollback safe.
- Migrations run when the new gateway instance starts, before it serves.
  They are idempotent (drizzle records what ran), so rerunning a deploy is safe.
- Never hand-edit the production schema to "undo" a migration. Fix forward with a new one.

## Smoke test

`npm run smoke -- --env prod|local` (`scripts/smoke.ts`) checks, read-only:

- `GET /healthz` on gateway, twokey-mcp and agent-runner, `GET /api/healthz` on web;
- `GET /healthz/deep` on the gateway (database, PayPal auth, webhook subscription; with
  `--env local` a missing webhook, `not_configured`, is accepted, since none is registered locally);
- `GET /api/results/summary` and `GET /api/hijack/status` on web;
- twokey-mcp answers 401 without a token, and MCP `tools/list` over Streamable HTTP with
  `SMOKE_AGENT_TOKEN` returns exactly the four agent tools.

It prints a checklist and exits 1 on any failure. `--env prod` needs `SMOKE_WEB_URL`,
`SMOKE_GATEWAY_URL`, `SMOKE_MCP_URL` and `SMOKE_RUNNER_URL` (service roots, no trailing slash).
`--env local` uses the dev ports; each variable overrides one. `SMOKE_AGENT_TOKEN` is a
`tk_agent_…` token from **Connect your agent** (`/onboarding/agent`) on the matching site; it is
sent only to the MCP URL and never printed.

Free services sleep when idle and the gateway took 37 s to wake (each check times out at 20 s),
so open each service's `/healthz` once before a smoke run.

### Production smoke log

| Date (IST) | Commit | Result | Notes |
| --- | --- | --- | --- |
| 2026-11-01 22:35 | 443f5c1 | 8/9 | Every check passed except MCP `tools/list`, which needs `SMOKE_AGENT_TOKEN`. That check is **deferred to phase 31**, where the production demo accounts and their tokens are created; no user is seeded on production before then. First run timed out on the gateway's two checks while it woke from sleep; rerun once warm. |

## Dashboard checklist (phase 30, once, in this order)

Never paste a secret value into a doc, issue, commit or chat. Values below are described, not
given.

1. **Create `release`.** With phase 30 on `origin/main` and CI green, run `scripts/release.sh` on
   that commit (above). This creates `origin/release`.
2. **Blueprint.** Render → **Blueprints** → the Two-Key Blueprint → **Sync** (or let auto-sync
   run). It applies `render.yaml`: the free plan, branch `release`, the gateway's start command,
   `NODE_ENV=production` and `DEMO_HOLD_MINUTES=15`. Then check by hand, for each of `gateway`,
   `web`, `twokey-mcp`, `agent-runner`:
   - **Settings → Instance Type: Free** (Starter from Nov 8, via `render.yaml`).
   - **Settings → Build & Deploy → Branch: `release`; Auto-Deploy: On Commit.**
   - gateway only: **Start Command**
     `npm run db:migrate -w @twokey/db && npm run start -w @twokey/gateway`, and no Pre-Deploy
     Command.
3. **Environment variables** (each service → **Environment**). New or changed since phase 5:

   | Service | Key | Value (described) | Build-time? |
   | --- | --- | --- | --- |
   | all four | `NODE_ENV` | `production` (set by the Blueprint) | web: yes |
   | gateway | `MERCHANT_REPORTING_CREDENTIALS` | **delete** (renamed) | |
   | gateway | `MERCHANT_API_CREDENTIALS` | one-line JSON by merchant slug: `{"stride-supply":{"clientId":…,"clientSecret":…}, …}` with all five slugs from `config/merchants.json`, **including `giftvault`** (its balance proves $0.00) | |
   | gateway | `METRICS_TOKEN` | `openssl rand -hex 32` (≥ 32 chars) | |
   | gateway | `VAPID_SUBJECT` | `mailto:` plus a contact address; without it phone pushes are off | |
   | gateway | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | the pair from `npx web-push generate-vapid-keys` (unchanged if already set) | |
   | gateway | `WEB_ORIGIN` | `https://<web>.onrender.com` | |
   | gateway | `PUBLIC_BASE_URL` | `https://<gateway>.onrender.com` (no trailing slash) | |
   | gateway | `DEMO_HOLD_MINUTES` | `15` (set by the Blueprint) | |
   | gateway | `MIGRATE_DATABASE_URL` | *blank* unless the database roles are applied (below) | |
   | web | `WEB_ORIGIN` | `https://<web>.onrender.com` | |
   | web | `MCP_PUBLIC_URL` | `https://<twokey-mcp>.onrender.com/mcp` | |
   | web | `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | the same value as the gateway's `VAPID_PUBLIC_KEY` | **yes** |
   | web | `NEXT_PUBLIC_AG_GRID_LICENSE_KEY` | *leave unset* until the licence arrives (Community fallback) | **yes** |
   | web | `COMPILER_PROVIDER`, `COMPILER_BASE_URL` | *blank* (Groq defaults) | |
   | web | `COMPILER_API_KEY` | your Groq key | |
   | web | `COMPILER_MODEL` | *blank* (`qwen/qwen3.8-27b`) until Nov 7; then `openai/gpt-oss-120b` | |
   | web | `AGENT_MODEL` | *blank* (`openai/gpt-oss-20b`) until Nov 7; then `openai/gpt-oss-120b` | |
   | web | `DAILY_BUDGET_USD_LIVE` | *blank* (default 2) | |
   | web | `HIJACK_DAILY_ATTEMPTS`, `HIJACK_DAILY_TOKENS` | *blank* (defaults 200 and 150,000) | |
   | agent-runner | `OPENROUTER_API_KEY`, `DAILY_BUDGET_USD_HIJACK` | **delete** (replaced) | |
   | agent-runner | `AGENT_LLM_API_KEY` | your Groq key | |
   | agent-runner | `AGENT_LLM_BASE_URL` | *blank* (Groq) | |
   | agent-runner | `AGENT_PROVIDER` | *blank* (`groq`) | |
   | agent-runner | `AGENT_MODEL` | *blank* (`openai/gpt-oss-20b`) until Nov 7; then `openai/gpt-oss-120b`, in step with web | |
   | agent-runner | `EVAL_LLM_API_KEY`, `EVAL_LLM_BASE_URL`, `EVAL_MODELS`, `DAILY_BUDGET_USD_EVAL` | *blank* (the evaluation never runs on Render) | |
   | agent-runner | `HIJACK_DAILY_TOKENS` | *blank* (150,000), same as web's | |
   | agent-runner | `DEMO_EPISODE_ID` | the demo hook's evaluation episode id, or *blank* | |
   | agent-runner | `MCP_URL` | `https://<twokey-mcp>.onrender.com` (the runner adds `/mcp`) | |

   Never set `EVAL_ENABLED`, `EVAL_ADMIN_TOKEN` or `SHOW_STYLEGUIDE` on Render. A **build-time**
   key is baked into the Next.js bundle: after changing it use **Save, rebuild, and deploy**
   (not **Save and deploy**). Changing any other key needs only **Save and deploy**.
4. **PayPal webhook.** Locally, with `.env.gateway` holding the **same sandbox app** as the live
   gateway:

   ```bash
   npm run paypal:webhook -- --url https://<gateway>.onrender.com
   ```

   It prints `PAYPAL_WEBHOOK_ID=<id>`. Confirm the gateway's `PAYPAL_WEBHOOK_ID` in Render equals
   it (update and **Save and deploy** if not). Then confirm it two ways:
   - developer.paypal.com → **Apps & Credentials** → **Sandbox** → the app → **Webhooks**: one
     webhook whose URL is exactly `https://<gateway>.onrender.com/webhooks/paypal`, with that id.
   - `curl -s https://<gateway>.onrender.com/healthz/deep` shows `"webhookSubscriptions":"ok"`.
     `wrong_url` means the registered URL differs from `PUBLIC_BASE_URL` + `/webhooks/paypal`;
     `not_found` means the id is wrong; `missing_events` means rerun the script.
5. **Deploy in order:** gateway (**Manual Deploy → Deploy latest commit**; watch the deploy
   log say `migrations applied`), then web (**Clear build cache & deploy**, for the build-time
   keys), twokey-mcp, agent-runner.
6. **Smoke:** `npm run smoke -- --env prod`; every line must be `[x]`. Phase 30 accepted 8/9:
   MCP `tools/list` waits for the phase 31 demo tokens (see the production smoke log).
7. **Rollback drill** (below), and add its row to the log.
8. **After the test split finishes** (not before), copy the evaluation results:
   `EXPORT_TARGET_DATABASE_URL=<Neon URL> npm run eval:export -- --dry-run`, check the counts,
   then the same without `--dry-run` (below).

Optional, not part of phase 30: least-privilege database roles (below).

## Neon database (exists)

The Neon project from phase 5 (Postgres 16, AWS US West 2, Oregon) is the production database.
Use its **direct** host (no `-pooler`), ending in `sslmode=require`. Keep the string in your
password manager only; locally keep it in your shell (for example `NEON_DATABASE_URL`), never in
a file in the repo. No shell or one-off jobs run on Render: run seeds, SQL and the export from
your machine against that URL.

## Evaluation results on production

The results explorer reads the evaluation tables. They are produced locally and copied once the
test split is done:

```bash
EXPORT_TARGET_DATABASE_URL=<Neon URL> npm run eval:export -- --dry-run
EXPORT_TARGET_DATABASE_URL=<Neon URL> npm run eval:export
```

(`--target <url>` works too, but npm echoes its command line, password included.)

`scripts/eval-export.ts` copies, in one transaction: `eval_tasks`, `attack_templates`,
`eval_episodes`, `eval_episode_listings`, `eval_runs`, `predictions`; the `mode = 'eval'`
sessions that runs point at, with their proposals and gate decisions; and what those rows
reference (the `eval_frozen` snapshot's listings, their merchants, the evaluation's rule cards
and its system user `eval@twokey.system`). Hijack attempts, live/demo/hijack sessions, payments,
approvals, webhooks, vault tokens and other users are never read or written. Merchants and the
system user are matched by slug and email and never changed on the target; agent token hashes are
not copied. Rows are upserted by primary key, so rerunning is safe. It refuses to run when the two
databases have different migrations (release first), when the target has evaluation rows the
local database lacks, or when a row would reference anything outside the evaluation. `--dry-run`
does the whole copy and rolls it back.

Dry run on 2026-11-01 (local database into a throwaway local copy; test split still running):
14 tables, 1,376 runs, 974 proposals, 2,738 gate decisions, 21 predictions; rolled back.

## twokey-mcp distribution

`twokey-mcp` is **not published to npm**. It ships as the **v1.0.0 GitHub Release asset**
`twokey-mcp-1.0.0.tgz` (url and sha256 pinned in `apps/mcp/release.json`). `/developers` and
`docs/claude-desktop.md` run `npx -y <release asset URL>`.

- `npm run mcp:release` rebuilds the tarball and checks it against the pinned sha256.
- `npm run mcp:pack-smoke -- --remote` installs the published asset and lists the four tools.
- A server change means a new version: bump `apps/mcp/package.json`, `npm run mcp:release --
  --record`, upload a new GitHub release, update the links.

## Rollback

**Dashboard → service → Events** → the last deploy marked **Deploy live** before the bad one →
**Rollback** → confirm. Roll back every service the release broke (gateway first). Rolling back
redeploys old code only; under the migrations policy the old code runs on the newer schema.

Rolling back turns off auto-deploy for that service, so the next push to `release` won't
undo it. Fix forward on `main`, release again, then turn **Auto-Deploy** back on (**Settings →
Build & Deploy**). Run `npm run smoke -- --env prod` after any rollback.

### Rollback drill log

Drill: release a harmless commit, roll the gateway (or all four) back to the previous deploy,
time it from clicking **Rollback** to **Deploy live**, smoke, then restore auto-deploy and
re-release.

| Date (IST) | Service | Rolled back from → to (deploy id) | Rollback time | Smoke after |
| --- | --- | --- | --- | --- |
| *pending: first drill after the production switch* | | | | |

## Database roles (optional, least privilege)

Until this is done every service connects as the Neon owner. `scripts/db-roles.sql` creates one
role per service: `twokey_gateway` (full DML, no DDL), `twokey_web` (reads all, writes only what
the web app writes, never payments, approvals or gate decisions) and `twokey_runner`. It also
creates `twokey_jobs`, a no-login role that owns pg-boss's schema. SECURITY.md lists what each
role may do; `packages/db/test/roles.test.ts` proves the denials.

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
   | gateway | `twokey_gateway` | `MIGRATE_DATABASE_URL` = the owner's URL: the start command migrates with it, then the gateway serves as `twokey_gateway` |
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
7. `npm run eval:export` writes as the owner (run it with the owner's URL).

## Health checks

`/healthz` answers `{"ok":true,"service":"gateway",...,"commit":"<sha>"}` and never touches PayPal
or the database, so a PayPal outage never restarts the gateway. `/healthz/deep` answers
`{"db":"ok","paypalAuth":"ok","webhookSubscriptions":"ok"}`; on any failure it returns HTTP 503
with the failing keys, and `missing` lists absent event types. PayPal results are cached for 60
seconds. `webhookSubscriptions` can be `not_configured` (no `PAYPAL_WEBHOOK_ID` or
`PUBLIC_BASE_URL`), `not_found`, `wrong_url`, `missing_events` or `fail`.

CI (`npm run check:secrets`) fails if `render.yaml` lists a secret on a service that may not hold
it, names a service other than the four, deploys from a branch other than `release`, sets
`NODE_ENV` to anything but `production`, or lists `EVAL_ENABLED`, `EVAL_ADMIN_TOKEN` or
`SHOW_STYLEGUIDE`. Every service also refuses to start if a secret is set where it doesn't belong.
