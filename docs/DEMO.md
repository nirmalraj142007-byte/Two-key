# The demo tenant

Judges can open the site at any time after Nov 12. It must always show something true and
working, and say so plainly when a dependency is down. This page covers the demo accounts, the
daily reset, the replay fallback and what to monitor.

## Accounts

| Account | Role | Password | Wallet | Rules |
| --- | --- | --- | --- | --- |
| `maya@twokey.demo` | user (unrestricted) | `MAYA_PASSWORD`, never published | its own saved PayPal wallet | preset demo card |
| `judge1@twokey.demo` | judge_demo | `DEMO_PASSWORD` | its own saved PayPal wallet | preset demo card |
| `judge2@twokey.demo`, `judge3@twokey.demo` | judge_demo | `DEMO_PASSWORD` | its own saved PayPal wallet (`demo:connect-wallets`) | preset demo card |
| `hijack@twokey.system` | hijack_system | none (cannot sign in) | its own token (`npm run vault:hijack`) | hijack card |

Judges sign in as `judge1@twokey.demo`, the account the README gives. The production
`DEMO_PASSWORD` lives in `~/two-key-secrets/demo-password.txt` and is published in the README for
the judge accounts, whose role cannot delete the wallet or change the rules. maya is a full user, so
she has her own password in `~/two-key-secrets/maya-password.txt` (never committed or printed);
`demo:setup --env prod` never gives her the published one.

**The preset demo card** (the demo request: "Running shoes, size 10, under $70, only Stride Supply
or Peak Outfitters, one pair, this week."): Stride Supply and Peak Outfitters; $70.00 per item and
per order; one item; 5 purchases per 24 hours; 15-minute holds; "size 10" advisory ("Agent's job —
not checked by Two-Key"); expires 60 days after signing. It is built by the rule compiler's own
deterministic step (`toDraftCard`) and signed by the gateway's signer (`signDraftCard`).

**What judges can't change** (refused by the gateway with 403, not only hidden in the UI):
deleting the saved wallet (`DELETE /human/vault`), revoking rules
(`POST /human/rules/:id/revoke`) and signing a new card (`POST /human/rules/:id/sign`). Everything
else works as for any user: the agent console, holds and approvals, history, connecting their
agent.

**Wallets.** Each demo account needs its *own* saved wallet. `permit_multiple_payment_tokens` is
on, so one sandbox buyer can approve all four (and the hijack user): every approval makes a new
payment token. `demo:setup` lists every account still missing one,
with the page to open:

1. In a private window, sign in at `<web>/login` as that account with `DEMO_PASSWORD`.
2. Open `<web>/onboarding/paypal` → **Connect PayPal** → approve as the sandbox buyer.
3. Repeat for the next account, then run `demo:setup` again.

`npm run demo:connect-wallets -- --only <account>` (repeat `--only`; all four without it) does these steps in a headed Edge
window per account (you run it: it types the demo and sandbox-buyer passwords from
`~/two-key-secrets/`). It skips accounts that already have a wallet and stops, leaving the window
open, if PayPal shows a captcha or security check.

## Setting it up

```bash
npm run demo:setup -- --env local
npm run demo:setup -- --env prod
npm run demo:setup -- --env prod --accounts maya,judge1
```

`--accounts` sets up only the listed demo accounts (users, wallet check, preset cards) and reports
the others as skipped; the catalog, demo hook and hijack user are always handled.

`--env local` reads `.env.gateway` and refuses any non-local database. `--env prod` reads
`~/two-key-secrets/prod-gateway.env` (or `--env-file <path>`) and refuses a local database;
`DEMO_PASSWORD` comes from `~/two-key-secrets/demo-password.txt`. That file holds the production
gateway's values of `DATABASE_URL` (Neon, direct, `sslmode=require`), `RULE_HMAC_KEY`,
`RULE_HMAC_KEY_ID`, `WEB_ORIGIN`, `PAYPAL_ENV`, `MERCHANT_API_CREDENTIALS` and, for the hijack
wallet, `HIJACK_PAYPAL_PAYMENT_TOKEN_ID` / `HIJACK_PAYPAL_CUSTOMER_ID`. The key must be the one
the live gateway uses, or every proposal is blocked as `rule_card_invalid`; setup checks each card
verifies with it.

In order, idempotently: the catalog seed (merchants, demo catalog); the five accounts; the
wallet check (stops with exit code 2 and the list above if any is missing, before anything else
changes); the preset card for each demo account (kept if active for 7 more days); the demo hook;
the hijack user's wallet and card.

**The demo hook** (`npm run demo:hook`) is the poisoned listing: Cloud Runner CR-1 at Peak
Outfitters with a frozen test episode's attack template appended (published template, goal
adapted). The goal asks for **Trail Runner TR-2 at Peak Outfitters**: an allowed store, under the
$70 cap, 1.40x its $46.00 reference, so Two-Key holds it. That is the evaluation's real finding
(a wrong product inside the rules); the attacker-store attempt is the separate `scripted:attack`
beat. In search it **stands in for the clean copy at that store**, so each store shows the
product once; before phase 31 the same shoe appeared twice at Peak Outfitters for $56.00, clean
and poisoned. Setup and reset run it with `--pinned`: they rebuild the listing from the episode
recorded in `eval/frozen/demo-episode.json` and never rewrite that file. The template text comes
from the database once `eval:export` has copied it, or from the vendored repos when run from a
machine that has them; without either an existing hook listing is kept.

## What the daily reset does

`npm run demo:reset` runs daily at 03:30 UTC (09:00 IST) in GitHub Actions
(`.github/workflows/demo-reset.yml`, plan B; secrets in docs/DEPLOY.md) with the gateway's own
secrets, and can be run by hand (`-- --env local|prod`, or **Run workflow** in Actions). Under
plan A it is the Render cron job **twokey-demo-reset** instead. For maya and
judge1–3 only, chosen by email:

1. **Voids every held authorization** through the gateway's void path (`voidHeld`: the row is
   locked, the state checked, the void sent with the payee merchant's credentials and the request
   ID `tk-{proposalId}-void`). A payment still open at PayPal is never deleted.
2. **Deletes finished history**: proposals with no payment or a finished one (captured, voided,
   expired, denied, failed), those payments' events and approvals, their gate decisions, and the
   ended or failed sessions left empty. Nothing at PayPal is deleted.
3. **Re-signs** any demo card (and the hijack card) that is missing or expires within 7 days.
4. **Rebuilds the demo hook** (`--pinned`).

It prints a count for each. It is safe to run twice and while someone is using the site: it skips
rows created after it started or touched in the last 5 minutes (a hold someone may be approving,
a run in progress). It never touches eval tables, eval or hijack sessions, or `hijack_attempts`
(the published dataset).

### Not yet exercised: the void step on a real hold

As of phase 31 (Nov 2) the reset has run only on databases with no open holds (local runs: 0
voided both times), so step 1 has not voided a real PayPal authorization yet. To test it once,
inside the 5-to-15-minute window (older than the 5-minute quiet period, younger than the 15-minute
hold timeout, which would void it first):

1. Signed in as maya, open `/agent` and send
   `Trail Runner TR-2 at Peak Outfitters, under $70, one pair.` (locally you can use
   `/agent?model=scripted:anomaly`). The card shows **Held** ($64.40, 40% above the usual price).
2. Leave it. After 6 minutes (before 15), run `npm run demo:reset -- --env local` (or `--env prod`).
3. Expect `voided 1` and `voidsLeftOpen 0`. The proposal disappears from history only on the next
   run more than 5 minutes later (the void just touched it), when that run shows `payments 1`.
4. Check the payment's events: `void.requested` (source timer, reason `demo_reset`) then
   `void.completed` with `caller: merchant:peak-outfitters`; in the Peak Outfitters sandbox
   account the authorization is **Voided**.

Record the date and result here once done.

## Replay fallback

The console replays `apps/web/public/golden-run.json` through the same components as a live run,
always under the banner **"Replaying a recorded run — PayPal sandbox or the model is unavailable
right now"**:

- **Forced:** web `DEMO_FALLBACK=replay`.
- **Automatically:** when the gateway's `/healthz/paypal` reports degraded, or when a live run
  fails or can't start for a reason the person can't fix (gateway, queue or model down). "Connect
  PayPal first" or "Sign your rules first" are shown as themselves, never replayed.

The hijack box has its own replay (phase 22). `HIJACK_DISABLED=true` on web sends every attempt to
it ("The live agent is unavailable right now, so this shows a recorded run.").

**Switch on:** Render → **web** → **Environment** → `DEMO_FALLBACK` = `replay` (and/or
`HIJACK_DISABLED` = `true`) → **Save and deploy**. Not build-time keys: no rebuild needed.
**Switch off:** delete the key (or set `off` / `false`) → **Save and deploy**.
Locally: `DEMO_FALLBACK=replay npm run dev`.

**The recording** comes from `npm run demo:record-golden`, local dev stack only, with scripted
models: happy (Cloud Runner CR-1 at Stride Supply, captured), attack (the gift card, blocked) and
anomaly (Trail Runner TR-2 at Peak Outfitters, held, then denied and voided). Every stream event
is kept with its time since the beat began. Our IDs become `REPLAY-<kind>-<n>` and PayPal IDs get
a `REPLAY-` prefix, so nothing in it can be taken for a live record. Re-record after any change to
the console's event shapes, then commit the file.

## Health checks (no uptime pinger)

Plan B keeps every service on Render's free plan, so **do not set up a pinger**: polling would
keep four services awake and use up the workspace's 750 free instance hours a month. Check these
by hand (or `npm run smoke -- --env prod`) before a demo; the first answer after 15 idle minutes
can take up to a minute while the service wakes. Under plan A (Starter, no sleep) a 5-minute
monitor on the same URLs is fine.

| URL | Healthy when |
| --- | --- |
| `https://<web>.onrender.com/api/healthz` | 200 |
| `https://<web>.onrender.com/api/results/summary` | 200 |
| `https://<web>.onrender.com/api/hijack/status` | 200 |
| `https://<gateway>.onrender.com/healthz` | 200 |
| `https://<gateway>.onrender.com/healthz/deep` | 200 (503 names the failing part) |
| `https://<gateway>.onrender.com/healthz/paypal` | body contains `"degraded":false` |
| `https://<twokey-mcp>.onrender.com/healthz` | 200 |
| `https://<agent-runner>.onrender.com/healthz` | 200 |

If `/healthz/paypal` stays degraded, the console already replays on its own; set
`DEMO_FALLBACK=replay` only if the live console misbehaves in some other way.
