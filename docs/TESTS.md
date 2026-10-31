# Tests

Counts are from `npx vitest run --reporter=json` at the phase 27 commit: **47 files, 491 tests, all passing**. Database tests create a throwaway `twokey_test_<hex>` database and drop it, so `npm run check` never touches the dev data.

```bash
npm run check            # lint + typecheck + all unit and integration tests + check:secrets
npm run test:coverage    # same tests with a v8 coverage summary (CI prints it on the run page)
E2E_SANDBOX=1 npx playwright test e2e/happy.spec.ts e2e/failure.spec.ts -c apps/web   # real PayPal sandbox
```

## Unit and integration tests, per package

| Package | Files | Tests | What they cover |
| --- | ---: | ---: | --- |
| `packages/core` | 5 | 200 | env and secret ownership, errors, money, payment state machine, rules engine (evaluate, gates), rule-card signing |
| `packages/db` | 1 | 4 | migrations, seed, budget helper |
| `packages/paypal` | 3 | 16 | PayPal error mapping, vault calls, webhook verification |
| `apps/gateway` | 15 | 111 | purchase path, lifecycle, webhooks, human authz and tenancy, events (SSE), health, catalog search, balances, hijack box, eval-only routes, boot |
| `apps/mcp` | 1 | 6 | the fixed four-tool surface, idempotency keys, error mapping |
| `apps/agent-runner` | 4 | 33 | tool-use loop and budgets, message adapters, reasoning capture, hijack runs, scripted adapter |
| `apps/web` | 14 | 84 | rule compiler, onboarding, console, history and approval views, redaction, copy checks, scripted-model guard |
| `eval` | 2 | 31 | metrics (`computeMetrics`), pipeline |
| `scripts` | 2 | 6 | secret-isolation check, listen address |

### Files and counts

| File | Tests |
| --- | ---: |
| `packages/core/test/core.test.ts` | 25 |
| `packages/core/test/payment-state.test.ts` | 113 |
| `packages/core/test/rules/evaluate.test.ts` | 22 |
| `packages/core/test/rules/gates.test.ts` | 15 |
| `packages/core/test/rules/sign.test.ts` | 25 |
| `packages/db/test/db.test.ts` | 4 |
| `packages/paypal/test/errors.test.ts` | 3 |
| `packages/paypal/test/vault.test.ts` | 1 |
| `packages/paypal/test/webhooks.test.ts` | 12 |
| `apps/gateway/test/app.test.ts` | 2 |
| `apps/gateway/test/balances.test.ts` | 9 |
| `apps/gateway/test/boot.test.ts` | 1 |
| `apps/gateway/test/catalog-search.test.ts` | 9 |
| `apps/gateway/test/events.test.ts` | 5 |
| `apps/gateway/test/health.test.ts` | 13 |
| `apps/gateway/test/hijack.test.ts` | 9 |
| `apps/gateway/test/human.test.ts` | 21 |
| `apps/gateway/test/internal-eval.test.ts` | 4 |
| `apps/gateway/test/lifecycle.test.ts` | 17 |
| `apps/gateway/test/purchase.test.ts` | 5 |
| `apps/gateway/test/safe-err.test.ts` | 2 |
| `apps/gateway/test/search-words.test.ts` | 1 |
| `apps/gateway/test/startup.test.ts` | 1 |
| `apps/gateway/test/webhooks.test.ts` | 12 |
| `apps/mcp/test/server.test.ts` | 6 |
| `apps/agent-runner/test/hijack.test.ts` | 10 |
| `apps/agent-runner/test/reasoning.test.ts` | 2 |
| `apps/agent-runner/test/run-session.test.ts` | 14 |
| `apps/agent-runner/test/scripted.test.ts` | 7 |
| `apps/web/test/approvals-view.test.ts` | 10 |
| `apps/web/test/client-ip.test.ts` | 3 |
| `apps/web/test/console-view.test.ts` | 9 |
| `apps/web/test/developers-copy.test.ts` | 4 |
| `apps/web/test/episodes-view.test.ts` | 6 |
| `apps/web/test/hijack-limits.test.ts` | 4 |
| `apps/web/test/hijack-view.test.ts` | 5 |
| `apps/web/test/history-view.test.ts` | 5 |
| `apps/web/test/onboarding.test.ts` | 14 |
| `apps/web/test/public-numbers.test.ts` | 2 |
| `apps/web/test/redact.test.ts` | 5 |
| `apps/web/test/rule-compiler.test.ts` | 12 |
| `apps/web/test/scripted-model.test.ts` | 2 |
| `apps/web/test/test-states.test.ts` | 3 |
| `eval/test/metrics.test.ts` | 21 |
| `eval/test/pipeline.test.ts` | 10 |
| `scripts/test/check-secret-isolation.test.ts` | 3 |
| `scripts/test/listen-address.test.ts` | 3 |

## Lifecycle

The money path, from proposal to the final payment state. Each case runs against a real (throwaway) Postgres with a mocked PayPal, so it can assert exact request IDs and call counts.

- Approve: one capture with `tk-<id>-capture`, state `captured`, approval `approved` via web: `apps/gateway/test/lifecycle.test.ts:366`
- Deny: one void, `voided`, approval `denied`; another user gets 404: `apps/gateway/test/lifecycle.test.ts:419`
- Timeout: the timeout job voids and marks the approval `timed_out`; running it again is a no-op: `apps/gateway/test/lifecycle.test.ts:462`
- Approve after the deadline: 409 and zero PayPal calls: `apps/gateway/test/lifecycle.test.ts:479`
- Concurrent approve: two at once give exactly one capture, one 200 and one 409: `apps/gateway/test/lifecycle.test.ts:498`
- Expired authorization: capture 422 `AUTHORIZATION_EXPIRED` ends `expired` and is never captured again: `apps/gateway/test/lifecycle.test.ts:520`
- Late webhook: `CAPTURE.COMPLETED` ten minutes late stays `captured` and is recorded `ignored_stale`: `apps/gateway/test/lifecycle.test.ts:553`
- Out-of-order webhook: a capture that arrives before `AUTHORIZATION.CREATED` still ends `captured`: `apps/gateway/test/webhooks.test.ts:181`
- Out-of-order webhook, unknown authorization: the event waits, then applies once the payment exists: `apps/gateway/test/webhooks.test.ts:255`
- Duplicate webhook: the same event posted twice is stored once and reported as a duplicate: `apps/gateway/test/webhooks.test.ts:203`
- Unverified webhook: a FAILURE verification answers 400 and leaves the payment unchanged: `apps/gateway/test/webhooks.test.ts:216`
- Unverified webhook, forged ID: a verified delivery still applies after a forged event claimed its ID: `apps/gateway/test/webhooks.test.ts:230`
- Verification outage: answers 503 (so PayPal retries) and stores nothing: `apps/gateway/test/webhooks.test.ts:243`
- Reconcile without a webhook: the reconcile job settles the payment from `GET authorization`: `apps/gateway/test/lifecycle.test.ts:593`
- Sweep overdue hold: the sweep voids a held payment past its deadline: `apps/gateway/test/lifecycle.test.ts:629`
- Hold without merchant credentials: blocked before any PayPal call: `apps/gateway/test/lifecycle.test.ts:672`
- Stuck `void_requested`: resent with the SAME request ID by the merchant, then `voided`: `apps/gateway/test/lifecycle.test.ts:698`
- Stuck `capture_requested`: resent with the SAME request ID by the platform, then `captured`: `apps/gateway/test/lifecycle.test.ts:731`
- Stuck but already settled at PayPal: no resend, state synced by the reconciler: `apps/gateway/test/lifecycle.test.ts:752`
- Blocked makes zero PayPal calls: the GiftVault gift card has no PayPal request and no payment row: `apps/gateway/test/purchase.test.ts:275`
- Idempotent create: the same Idempotency-Key replays without a second order: `apps/gateway/test/purchase.test.ts:340`
- Gateway resolves price and payee itself: the registry payee wins over what the agent sent: `apps/gateway/test/purchase.test.ts:290`
- Evaluation mode never calls PayPal: `apps/gateway/test/purchase.test.ts:369`

## End-to-end (Playwright, `apps/web/e2e`)

| Spec | Tests | Needs |
| --- | ---: | --- |
| `login.spec.ts` | 3 | web, local Postgres, `db:seed-users` |
| `console.spec.ts` | 1 | web, local Postgres (the event stream is stubbed) |
| `onboarding.spec.ts` | 3 | web, local Postgres |
| `states.spec.ts` | 4 | web, local Postgres |
| `styleguide.spec.ts` | 2 | web |
| `judge-gap-a.spec.ts`, `judge-gap-b.spec.ts` | 10, 7 | web, local Postgres |
| `happy.spec.ts` | 1 | `E2E_SANDBOX=1`, full stack, real PayPal sandbox, a user with a saved wallet and a signed card |
| `failure.spec.ts` | 2 | same as `happy.spec.ts` |

The sandbox specs drive the console with a scripted model (`?model=scripted:<name>`, scripts in `apps/agent-runner/scripts/`), so no LLM is involved and the run is deterministic:

- `scripted:happy`: Cloud Runner CR-1 at Stride Supply is captured and the card shows a PayPal capture ID.
- `scripted:attack`: the $189 GiftVault card is blocked ("Blocked · no PayPal order"); History has no PayPal order, authorization or capture ID for it.
- `scripted:anomaly`: Trail Runner TR-2 at Peak Outfitters is held; Deny on `/m/approve/<approval id>` ends "Voided · no charge".

Scripted models are refused in production (web and agent runner) unless `ALLOW_SCRIPTED=true`: `apps/agent-runner/test/scripted.test.ts` and `apps/web/test/scripted-model.test.ts`. They run on their own pg-boss queue (`agent.run.scripted`), so only a runner that knows scripts picks them up.

The specs use `judge1@twokey.demo` unless `E2E_USER` names another user. They fail at once with a plain message when `E2E_SANDBOX=1`, `DEMO_PASSWORD` or the PayPal credentials are missing, or when the console cannot start a run.

## CI

- `.github/workflows/ci.yml` (every push and pull request): Postgres 16, `npm run check`, then `npm run test:coverage` with the totals in the run summary.
- `.github/workflows/e2e-sandbox.yml` (manual: `gh workflow run e2e-sandbox.yml`): starts the stack on a fresh database, runs the happy and failure specs against the real PayPal sandbox and uploads Playwright traces. Repository secrets: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `MERCHANT_API_CREDENTIALS`, `E2E_VAULT_PAYMENT_TOKEN_ID`, `E2E_VAULT_CUSTOMER_ID`.
