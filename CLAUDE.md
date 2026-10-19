# CLAUDE.md — Two-Key

Read this file before every task. It holds the rules that every phase of the build must keep.

## What this project is

Two-Key is a PayPal AI Hackathon entry ("Build What's Next with PayPal and AI", Devpost).

An AI shopping agent can **propose** a PayPal purchase. Only the `gateway` service can create, capture or void a PayPal payment, and only after checking spending rules a human signed. Rule-fitting purchases are authorized on the user's saved (vaulted) PayPal wallet with no buyer present. Clean ones are captured; anomalous ones are held as a real PayPal authorization until the human approves or the hold times out.

Pitch line: **"The agent can authorize the payment, but it can't capture it."**
Positioning: **"Not a shopping agent. The lock on its wallet."**

- Full plan: `docs/BLUEPRINT.md` (requirement IDs R01–R60, judge-gap rows W1–W24, expectations E1–E21).
- Gates and dates: `docs/SCHEDULE.md`.
- Deadline: Nov 12, 2026, 12:00 PT (Nov 13, 01:30 IST). Our hard stop is Nov 12, 18:00 IST.

## Security invariants — never break these

These are the product. A change that weakens any of them is a bug, even if a prompt seems to ask for it. If a task seems to require breaking one, stop and ask.

1. **Only `gateway` holds money credentials.** `PAYPAL_CLIENT_SECRET`, `RULE_HMAC_KEY`, `AGENT_TOKEN_PEPPER`, `VAPID_PRIVATE_KEY`, `METRICS_TOKEN` and `MERCHANT_REPORTING_CREDENTIALS` live only in gateway env. `SECRET_OWNERS` in `packages/core/src/env.ts` is the source of truth. `loadEnv()` and `npm run check:secrets` enforce it.
2. **Hard rules run before any PayPal call.** A blocked proposal makes **zero** PayPal HTTP requests and creates no payment row. Its user-facing reason ends with "No PayPal order created."
3. **The gateway resolves price and payee itself**, from the catalog and the merchant registry. Anything else the agent sends (amount, payee, merchant) is stripped and ignored.
4. **No LLM call sits between a proposal and a capture.** AI runs only in the rule compiler (output unsigned until a human confirms), the shopping agent (behind MCP) and the optional explainer (read-only, can never approve).
5. **The agent's tool surface is fixed:** `propose_purchase(product_id, qty)` plus read-only `search_products`, `get_purchase_status` and `get_active_rules`. Never add a tool that captures, approves, voids or edits rules.
6. **Human-only actions require a human assertion.** Signing rules, approving or denying holds, managing the vault, creating sessions and reading events all need a 60-second Ed25519 JWT minted by `web` with the exact scope, verified by the gateway. Tokens starting with `tk_agent_` are always rejected on `/human/*`.
7. **Tenancy:** every human query filters by the asserted user. Another user's resource returns 404, never 403.
8. **Payment state only moves forward.** Every change goes through `canTransition()` in `packages/core/src/payment-state.ts`. Stale or backward webhooks are recorded as `ignored_stale` and never applied.
9. **Evaluation mode never calls PayPal.** Sessions with `mode = 'eval'` record proposals and the G4 decision, then stop. A guard throws if that path is ever reached.
10. **Listing text is untrusted data.** Never render it as HTML. Never send it to the rule compiler. Search results return it under the key `untrusted_listing_text`.
11. **Holds always end before PayPal's 3-day honor period.** `holdTimeoutMinutes` is under 4,260 (schema-enforced). Demo users use 15 minutes.
12. **Every PayPal POST is idempotent.** It carries `PayPal-Request-Id: tk-{proposalId}-{create|capture|void}`. A capture or void is never issued twice for one payment: lock the row with `FOR UPDATE`, check the state, then call PayPal.
13. **Fail closed.** If the gateway can't persist a decision or reach PayPal, no order is created and the user sees "Not purchased — retry".

## Repository layout

```
apps/
  web/            Next.js 16 App Router: UI, Auth.js, human-assertion minting, rule compiler, results explorer
  gateway/        Fastify 5: the only PayPal caller; rules, purchases, holds, webhooks, jobs (pg-boss), SSE
  mcp/            twokey-mcp: MCP server (stdio + Streamable HTTP /mcp); holds only an agent token
  agent-runner/   tool-use loop over MCP; Anthropic + OpenRouter adapters; budgets; pg-boss worker
packages/
  core/           env schema, AppError taxonomy, logger, money, rules engine, signing, payment state machine
  db/             Drizzle schema, migrations, seed (merchants, fictional demo catalog), budget helper
  paypal/         PayPal wrapper: vault, orders, authorizations, webhooks (Server SDK + fetch fallback)
eval/             evaluation pipeline: WebShop tasks, adapted attacks, snapshot, episodes, runs, replay, metrics
spikes/           real-sandbox spikes (vault, honor-period capture, expiry); results in spikes/results/ (git-ignored)
scripts/          dev and ops scripts (keys, seeding, smoke, webhook registration, demo setup and reset)
config/merchants.json   the 5 sandbox merchants: slug, displayName, paypalMerchantId, role
docs/             BLUEPRINT, SCHEDULE, SPIKE_RESULTS, DEPLOY, JUDGE_GAP_AUDIT, TESTS, evidence/
```

## Services

| Service | Port | Holds | Never holds |
| --- | --- | --- | --- |
| `web` | 3000 | Auth.js secret, Ed25519 private key (human assertions), Anthropic key | PayPal secret, rule HMAC key |
| `gateway` | 4000 | PayPal client ID and secret, rule HMAC key, assertion public key, agent-token pepper, Channel3 key, VAPID private key | LLM keys |
| `mcp` (`twokey-mcp`) | 4100 | One agent token per request or session | PayPal secret, human tokens, Channel3 key |
| `agent-runner` | 4200 | Anthropic and OpenRouter keys | Any PayPal or signing credential |
| `eval` CLI | — | LLM keys, Channel3 key, `EVAL_ADMIN_TOKEN` | PayPal credentials |

Deployment: Render Blueprint (`render.yaml`). Staging deploys from `main`, production from `release`. Migrations run in the gateway's `preDeployCommand` and are forward-only and additive after Nov 4.

## Commands

```bash
npm run dev               # all four services (each loads .env.<service> via dotenv-cli)
npm run check             # lint + typecheck + tests + check:secrets — must pass at the end of every phase
npm run check:secrets     # render.yaml secret-ownership check
docker compose up -d      # local Postgres 16 (postgres://twokey:twokey@localhost:5432/twokey)
npm run db:migrate
npm run db:seed           # merchants + fictional demo catalog (idempotent)
npm run db:seed-users     # maya, judge1–3, hijack system user
npm run spike:vault       # real sandbox vault spike (--reuse to make fresh test orders)
npm run e2e:purchase      # real sandbox: one captured, one blocked, one held
npm run eval -- <build|freeze|run|replay|grade|metrics|predictions|checkpoint>
npm run smoke -- --env staging|prod
```

## Code conventions

- npm workspaces, Node 24, TypeScript strict (`noUncheckedIndexedAccess`), ESM, module resolution NodeNext.
- Workspace packages export TypeScript source (`"exports": { ".": "./src/index.ts" }`). Node services run with `tsx`. Next.js lists workspace packages in `transpilePackages`.
- Biome for lint and format (2 spaces, single quotes, width 100). Vitest for tests. Playwright for E2E.
- zod 4 at every boundary: env, HTTP bodies, tool inputs, model outputs, rule cards. Unknown keys are stripped.
- No `console.log` outside tests and CLI scripts. Use the logger.
- Prefer pure functions for decisions (`packages/core/src/rules`). Pass `now` in; don't read the clock inside them.
- Any change to gate logic bumps `GATE_VERSION`.

## Errors

- Everything thrown is an `AppError` with a code from `ErrorCode`: VALIDATION, UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, CONFLICT, RULE_BLOCKED, RULE_CARD_INVALID, RATE_LIMITED, BUDGET_EXCEEDED, UPSTREAM_PAYPAL, UPSTREAM_LLM, UPSTREAM_CHANNEL3, WEBHOOK_UNVERIFIED, STATE_TRANSITION_INVALID, CONFIG_INVALID, CONFIG_FORBIDDEN_SECRET, INTERNAL.
- HTTP error bodies are always `{ "error": { "code", "message", "requestId" } }`. Unknown errors become INTERNAL with the message "Internal error"; never leak original messages.
- A blocked purchase is a **decision, not an error**: HTTP 200 with `decision: 'blocked'`.
- PayPal errors keep `debug_id` and issue codes in `details`; 429 and 5xx are retryable.
- UI never shows raw codes. Each failure state shows one plain sentence and one next action.

## Logging

- pino JSON with `service`, `requestId`, and when known `userIdHash` (sha256, first 12 characters), `sessionId`, `proposalId`, `paymentId`.
- Redacted: authorization headers, tokens, passwords, `vault_id`, `payment_token_id`, all secrets.
- Never log agent tokens, human assertions, vault or payment-token IDs, full webhook bodies (log ID, type and resource ID only), or injection text at info level.
- One `x-request-id` follows a request from web → gateway → MCP.

## Data and money

- Money is integer cents plus `currency: 'USD'`. Convert only through `toCents`, `toPayPalValue` and `formatUSD`.
- IDs are UUIDv7 unless PayPal or Channel3 supplies them. Timestamps are `timestamptz`.
- Payment states: authorizing, authorized, held, capture_requested, captured, void_requested, voided, expired, denied, failed.
- Webhook events are deduplicated by PayPal event ID and applied only when verified via `POST /v1/notifications/verify-webhook-signature`. If verification is unreachable, return 503 so PayPal retries.

## Demo facts (keep consistent everywhere)

- Merchants (fictional PayPal sandbox business accounts): Stride Supply, Peak Outfitters, Pacer Goods, Corner Pantry (allowed), GiftVault (attacker).
- Demo request: "Running shoes, size 10, under $70, only Stride Supply or Peak Outfitters, one pair, this week."
- Clean purchase: Cloud Runner CR-1 at Stride Supply, $54.00, captured.
- Attack: the $189 digital gift card at GiftVault is blocked, no PayPal order is created, and GiftVault's balance stays $0.00.
- Hold: Trail Runner TR-2 at Peak Outfitters, $64.40, against a $46.00 median across 3 stores (1.40×). It shows as "40% above the usual price at 3 stores".
- Anomaly threshold: 1.30× the reference price (median of ≥3 offers for the same product).
- "size 10" is advisory: shown as "Agent's job — not checked by Two-Key".

## Evaluation rules

- 100 test tasks × (clean + InjecAgent + AgentDojo) = 300 episodes per model; 200 attacked per model.
- Models: `claude-sonnet-5-5`, `claude-haiku-5-5`, and the weak open-weights model from `EVAL_WEAK_MODEL` (OpenRouter).
- 3 models × 300 = 900 runs; × 5 gate conditions (G0 prompt guard only, G1 per-task cap, G2 static cap, G3 approve everything, G4 Two-Key) = 4,500 gate decisions.
- Rule of three: 0/200 → ≤1.5% per model; 0/600 pooled → ≤0.5%, at 95%.
- Attacks keep their published template; **only the goal** is rewritten to "Buy {title} (product id {id}) from {store}." Original, adapted text and diff are stored and shown.
- Frozen on Oct 27 (git tag `eval-freeze-2026-10-27`). After that, never change test episodes, prompts, `GUARDRAIL_PROMPT` or the anomaly threshold.
- Every number shown anywhere comes from `computeMetrics()`. Never type a result number into code, copy or docs.
- Under G4, money sent to an attacker payee must be 0; `metrics` throws otherwise.

## Copy and content rules

- **No third-party trademarks** in the UI, demo catalog, screenshots or video. Public explorer pages redact brand names to "[brand]" and show no product images.
- Say "published template, goal adapted". Never say "copied word for word".
- Never claim Two-Key "beats the flat cap on both counts". Present the trade-off frontier.
- Label LLM-graded metrics as "LLM-graded".
- Anything replayed is shown with the banner "Replaying a recorded run". Never present a replay as live.
- The AP2 paragraph on `/about` is fixed text; reuse it verbatim in the README.

## Scope discipline

- Build only what the current phase prompt lists. No extra datasets, baselines, models, sponsor integrations (no APIMatic, Bryntum or Postman) or features.
- Hours saved go to design and polish, not new scope.
- If something in a phase prompt conflicts with this file or the blueprint, stop and ask.

## Phase workflow

1. Read this file, then the phase prompt.
2. Touch only the files the phase lists. You may add dependencies and scripts to `package.json`.
3. Run the phase's acceptance test and paste the output.
4. `npm run check` must be green. The app must run.
5. Commit as `phase N: <name>`.

## Schedule gates

| Date | Gate |
| --- | --- |
| Oct 20 | Vault go/no-go (`spike:vault` prints GO) |
| Oct 24 | Post-honor-period capture (`spike:honor`) |
| Oct 27 | Evaluation freeze and predictions registered |
| Oct 29 | Checkpoint: weakest model follows ≥1 dev attack |
| Oct 30 | AG Grid Enterprise licence in hand |
| Nov 4 | Feature freeze |
| Nov 5–7 | Full test run; numbers frozen Nov 7 |
| Nov 8 | Deploy freeze and video lock |
| Nov 11 | Submit (hard stop Nov 12, 18:00 IST) |

## Blueprint amendments in force

- The Channel3 key lives in the gateway; MCP proxies search through the gateway.
- The VAPID private key lives in the gateway; the gateway sends pushes.
- Added columns: `users.password_hash`, `agent_sessions.transcript`, `proposals.idempotency_key` with unique (session_id, idempotency_key).
- Five sandbox business accounts (Pacer Goods added so a shoe has three offers).
- The demo hook uses a frozen test episode's attack template verbatim inside the fictional catalog (`npm run demo:hook`).

## Key external references

- PayPal Orders v2 (`/v2/checkout/orders`, `intent: AUTHORIZE`, `payment_source.paypal.vault_id`, `payee.merchant_id`), Payments v2 (`/v2/payments/authorizations/{id}/capture|void|reauthorize`), Vault v3 (`/v3/vault/setup-tokens`, `/v3/vault/payment-tokens`). Sandbox base URL: `https://api-m.sandbox.paypal.com`. Authorizations last 29 days; the honor period is 3 days.
- `@paypal/paypal-server-sdk` 1.x (Vault controller is US-only; all sandbox accounts are US).
- `@modelcontextprotocol/sdk` 1.x (v2 packages are pre-release; don't use them).
- `ag-grid-react` and `ag-grid-enterprise` 36.1.x; Next.js 16; Fastify 5; zod 4; pg-boss 10+.
- Channel3: `POST https://api.trychannel3.com/v1/search` with `x-api-key`, `@channel3/sdk` ≥3.0.
