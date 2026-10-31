# Security

What protects Two-Key beyond its core invariants (CLAUDE.md), the results of the phase 28
checks, and the dependency advisories we accept, with reasons. Operations and alerts are in
[OPERATIONS.md](OPERATIONS.md); database roles are applied as described in
[DEPLOY.md](DEPLOY.md#database-roles-least-privilege).

## HTTP hardening

### Gateway (Fastify)

- `@fastify/helmet` on every response. The gateway serves only JSON and event streams, so its
  CSP is `default-src 'none'; frame-ancestors 'none'`.
- `@fastify/cors`: the web origin (`WEB_ORIGIN`) only, and only on `/human/*` (the console's
  and inbox's event streams) and `/public/*` (the hijack stream). No other route sends CORS
  headers. No credentials mode: the bearer assertion is the credential.
- `@fastify/rate-limit`, per route, with the standard error body (`RATE_LIMITED`, 429,
  `retry-after`):

  | Route | Limit | Key |
  | --- | --- | --- |
  | `POST /agent/proposals` | 30 per minute | the verified agent session (checked after the token, so a bad token can't spend a session's allowance) |
  | `POST /webhooks/paypal` | 600 per minute | one bucket: PayPal is the only legitimate sender |
  | `/public/*` | 60 per minute | client IP |

- Client IP is the **rightmost** `x-forwarded-for` entry, the one Render's proxy appends; the
  same `clientIp()` helper (`packages/core/src/client-ip.ts`) keys the web app's hijack and
  sign-in limits. Fastify's `trustProxy` trusts exactly one hop, so `req.ip` agrees. A test
  sends a different faked left-most entry on every request and still gets limited.
- Body limit 64 KB (413 with the standard error body). The largest real body, a PayPal
  webhook, is about 5 KB.
- `/metrics` needs `Authorization: Bearer METRICS_TOKEN` (constant-time compare); 401
  otherwise, and when the token is not configured.
- `EVAL_ENABLED=true` refuses to start when `NODE_ENV=production` or when
  `RENDER_SERVICE_NAME` ends in `-prod`. Without it, `/internal/eval/*` is not mounted (404).

### Web (Next.js)

Static headers (`next.config.ts`): `Strict-Transport-Security: max-age=63072000;
includeSubDomains`, `Referrer-Policy: strict-origin-when-cross-origin`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(),
microphone=(), geolocation=()`, no `X-Powered-By`.

Content-Security-Policy (`apps/web/proxy.ts`, built by `lib/csp.ts`), with a fresh nonce per
request, the strategy Next.js recommends:

```
default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self' <gateway origin>; worker-src 'self';
manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

- Development adds `'unsafe-eval'` to `script-src` (React's dev-only stack reconstruction).
- `style-src 'unsafe-inline'`: AG Grid, AG Charts, Radix and React `style` props write inline
  styles. A style nonce would make browsers ignore `'unsafe-inline'` and break them. Inline
  styles cannot run script.
- `connect-src` names the gateway because the console and approvals inbox open their event
  streams there directly. `worker-src 'self'` covers the push service worker (`/sw.js`).

**CSP violations found and fixed.** The first production build (`next build && next start`)
blocked every script on every page: about 14 "Loading the script … violates … script-src"
errors and 9 "Executing inline script violates …" errors per page. Most pages were
prerendered (Cache Components, static or partial prerender), and a prerendered shell is built
before any request exists, so its scripts carry no nonce. Next's CSP guide says nonces need
dynamic rendering and that partial prerendering is incompatible with them. Fix: the root
layout awaits `connection()` and sets `export const instant = false`, so every page renders
per request and Next stamps the nonce on every script. `'use cache'` data caching is
unaffected. After the fix, `/login`, `/results`, `/results/episodes`, `/about`, `/hijack` and
`/developers` loaded and hydrated in Edge with no CSP violations. On a production build served
on :3000, the states spec passed all 15 page states (approvals and phone approval included).
The console stream spec passed 5 of 5 runs, and the sandbox failure spec (blocked attack;
held, then denied on the phone page, then voided) passed with `E2E_SANDBOX=1
E2E_USER=e2e@twokey.demo`. Scripted models run in a production build only with
`ALLOW_SCRIPTED=true`. Trade-off: no static shells, so each page view is server-rendered.

`connect-src` is read from the web service's `GATEWAY_URL` on every request (proxy.ts runs
at request time), never hard-coded: a production build started with an https `GATEWAY_URL`
served `connect-src 'self' https://<that host>`. On Render it is the gateway's public https
URL.

Sign-in is limited to 5 attempts per minute per IP hash (`rate-limiter-flexible`, in memory;
the web service runs as one instance). A successful sign-in clears that IP's count, so people
who type the right password are never slowed. Over the limit the form says "Too many sign-in
attempts. Wait a minute, then try again."

## Secrets

`SECRET_OWNERS` (`packages/core/src/env.ts`) is the source of truth; `loadEnv()` refuses a
secret on a service that may not hold it and `npm run check:secrets` checks `render.yaml`.
Added in phase 28: `METRICS_TOKEN` (gateway), `HIJACK_PAYPAL_CUSTOMER_ID` (gateway, alongside
`HIJACK_PAYPAL_PAYMENT_TOKEN_ID`), `MIGRATE_DATABASE_URL` (gateway; the owner URL used only by
migrations). `EVAL_ADMIN_TOKEN` stays gateway + eval and, like `EVAL_ENABLED`, is never in
`render.yaml` (the secret check fails if it is). There is no separate merchant reporting
credential: `MERCHANT_API_CREDENTIALS` covers voids and balances.

CI runs `gitleaks/gitleaks-action` on every push. Phase 28 local run (gitleaks 8.24.3, full
history): `63 commits scanned … no leaks found`.

## Dependency advisories

CI runs `node scripts/audit-gate.mjs`: `npm audit --omit=dev`, failing on any high or critical
advisory that is not a listed exception. Each exception has a review date and stops applying
after it.

Phase 28 ran `npm audit fix` (no breaking changes). Fixed: `follow-redirects` (high),
`fast-uri`, `minimatch` and `@ts-morph/common` / `ts-morph` (moderate). Production
dependencies after the fix: 0 critical, 1 high, 4 moderate, 2 low.

| Advisory | Package | Severity | Why it stays | Until |
| --- | --- | --- | --- | --- |
| GHSA-gpj5-g38j-94v9 | drizzle-orm < 0.45.2 | high | SQL injection through escaped **identifiers**. Every identifier we pass comes from our own schema code, never from input (see the SQL check below). The fix is 0.45.x, which npm marks as breaking, and it would change the ORM under the running test evaluation. Upgrade after the test split (Nov 7). | 2026-11-15 |
| GHSA-gcqx-w48m-w2h4 | deepmerge, via shadcn (`@shadcn/registry`) | low | `shadcn` is the component CLI, used only at development time to add components; no runtime path calls it. The fix is a breaking downgrade to shadcn 1.0.0. | — |
| (moderate, via deepmerge / ts-morph) | shadcn | moderate | As above: CLI only. | — |

Dev-only advisories (not shipped; reported by Render's build because it installs dev
dependencies): `vitest` and `tinypool` (critical, test runner; the RCE needs an attacker
controlling test worker options), `@vitest/mocker`, `@vitest/coverage-v8`, `test-exclude`,
`glob`, `minimatch` (test tooling), `drizzle-kit`, `esbuild` and `@esbuild-kit/*` (migration
generator; the esbuild issue affects its dev server, which we never run). Each fix is a major
version (vitest 5, drizzle-kit 0.18 downgrade). We revisit after the deadline.

## Code checks (phase 28)

| Check | Result |
| --- | --- |
| `sql.raw`, `sql.identifier`, `.unsafe(`, string-built SQL | Two uses, both justified: `packages/db/src/testing.ts` runs `create database` / `drop database` with a name it generates itself (`twokey_test_` + random hex); `CREATE DATABASE` cannot take a bind parameter. Every other query uses Drizzle's query builder or the `sql` template with bound parameters. No identifier ever comes from input. |
| `dangerouslySetInnerHTML`, `innerHTML`, `insertAdjacentHTML`, `document.write` | None in `apps/` or `packages/`. The only matches are two comments saying they are not used. |
| Listing and injection text | Rendered as text everywhere: `AgentTranscript` puts listing text in a `<blockquote>` as a React text child (the console spec asserts that `<img src=x onerror=…>` shows as text and creates no element). The hijack box takes the injection in a `<textarea>` and shows results as text. The results explorer shows attack templates as text. Search results return listing text under `untrusted_listing_text`; it never reaches the rule compiler. |
| Log lines that could carry a token or vault ID | Redaction covers `authorization`, `token`, `password`, `vault_id`, `vaultId`, `payment_token_id`, `paymentTokenId` and secrets at any depth. PayPal paths are logged as templates (`/v3/vault/payment-tokens/{id}`). Raw errors that could carry SQL parameters (vault and payment-token IDs among them) now pass through `safeErr()` in the proposal-failure and job-failure lines, as the request error handler already did. Webhooks log ID, type and resource ID only. Agent tokens and human assertions are never logged. |

## Database least privilege

`scripts/db-roles.sql` creates `twokey_gateway` (full DML, no DDL), `twokey_web` (reads all;
writes users, draft rule cards, push subscriptions, hijack attempts, its own session endings
and the compiler's budget; never payments, approvals or gate decisions) and `twokey_runner`
(reads all; writes transcripts and session status, reasoning excerpts, budget and hijack
attempts). Row-level security lets web insert and update rule cards only as unsigned drafts.
pg-boss's schema belongs to `twokey_jobs` (gateway and runner are members, because pg-boss
maintenance needs owner rights there); web gets plain DML in it. Gateway and runner can
therefore drop the job schema; we accept that, since the daily sweep voids any hold whose
timer is lost.

`packages/db/test/roles.test.ts` applies the script, twice, to a throwaway database under
suffixed role names, which it drops afterwards. It asserts the denied statements fail with
`42501`. The script has not been applied to the local development database or to Render yet;
DEPLOY.md lists the steps for phase 30.
