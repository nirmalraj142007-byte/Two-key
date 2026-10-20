# Spike results

Appended by `npm run spike:vault` and `npm run spike:honor`. Vault and payment-token IDs are never written here.

## Vault spike — 2026-10-19T13:55:07.583Z (run `20261019135507-d68b`)

| Step | Result | Detail |
| --- | --- | --- |
| a | OK | setup token 8BT56954EU506071A status PAYER_ACTION_REQUIRED |
| b | FAIL | not APPROVED within 5 minutes (statuses seen: PAYER_ACTION_REQUIRED) |
| d | FAIL | skipped: no vaulted payment token |
| e | FAIL | skipped: no vaulted payment token |
| f | FAIL | skipped: no vaulted payment token |
| g | FAIL | skipped: no vaulted payment token |

- Honor-period authorization: none
- LADDER_A_FAILED: not run
- **NO-GO: no vaulted payment token**

## Vault spike — 2026-10-19T14:01:02.069Z (run `20261019140102-5b57`)

| Step | Result | Detail |
| --- | --- | --- |
| a | OK | setup token 35X11212KF594584R status PAYER_ACTION_REQUIRED |
| b | OK | setup token APPROVED (statuses seen: PAYER_ACTION_REQUIRED -> APPROVED) |
| c | OK | payment token created (customer present); saved to spikes/results/vault.json |
| d | OK | order A 21P1158010424021J COMPLETED; authorization 0X533610ER475260E CREATED |
| d | OK | capture 9B960828VW625451S COMPLETED |
| d | OK | replay with same PayPal-Request-Id -> order 21P1158010424021J (same order) |
| e | OK | order B 69G46974GB838033L COMPLETED; authorization 5E990482LF9493607 CREATED |
| e | OK | void -> authorization status VOIDED |
| f | OK | order C 0SP17637BH721754V payee Stride Supply; authorization 3ST26804A6874654P CREATED |
| f | OK | capture 4J1226984K781532W COMPLETED |
| g | OK | order D 1LP61304B8947721W; authorization 93927348PL797874L CREATED (expires 2026-11-17T14:07:27Z); saved to spikes/results/honor.json |

- Honor-period authorization: 93927348PL797874L
- LADDER_A_OK
- **GO**

## PayPal-side verification 2026-10-19

Read back from PayPal at 2026-10-19T14:08:55.161Z for vault-spike run `20261019140102-5b57` (`npm run spike:verify`).

| order | PayPal status | amount | payee merchant_id | expected | result |
| --- | --- | --- | --- | --- | --- |
| A | order COMPLETED / capture COMPLETED | 1.00 USD | VV4V2YAUNBQHJ | order COMPLETED / capture COMPLETED, 1.00 USD, platform payee (not a registry merchant) | MATCH |
| B | authorization VOIDED | 1.00 USD | VV4V2YAUNBQHJ | authorization VOIDED, 1.00 USD | MATCH |
| C | capture COMPLETED | 1.00 USD | AYT4UTUV3UERE | capture COMPLETED, 1.00 USD, AYT4UTUV3UERE (Stride Supply) | MATCH |
| D | authorization CREATED | 1.00 USD | VV4V2YAUNBQHJ | authorization CREATED, 1.00 USD, expiration in the future | MATCH |

- A: order 21P1158010424021J, capture 9B960828VW625451S
- B: authorization 5E990482LF9493607
- C: capture 4J1226984K781532W; seller net_amount 0.48 USD (paypal_fee 0.52 USD)
- D: authorization 93927348PL797874L; expiration_time 2026-11-17T14:07:27Z
- **ALL MATCH**

## Vault spike — 2026-10-19T17:40:23.670Z (run `20261019174023-6b7a`, --reuse)

| Step | Result | Detail |
| --- | --- | --- |
| a-c | OK | reusing payment token from spikes/results/vault.json (created 2026-10-19T14:03:16.584Z) |
| d | OK | order A 67N74960AN7290051 COMPLETED; authorization 79S40865HL497812P CREATED |
| d | OK | capture 7GP3983100027992T COMPLETED |
| d | OK | replay with same PayPal-Request-Id -> order 67N74960AN7290051 (same order) |
| e | OK | order B 8D882628XJ880764A COMPLETED; authorization 8KC71839BR426974K CREATED |
| e | OK | void -> authorization status VOIDED |
| f | OK | order C 2VX195593H007214E payee Stride Supply; authorization 345384788H105010M CREATED |
| f | OK | capture 4X736043S9319133B COMPLETED |
| g | OK | order D 2LL941790B488574S; authorization 2R794194KG4033154 CREATED (expires 2026-11-17T17:44:30Z); saved to spikes/results/honor.json |

- Honor-period authorization: 2R794194KG4033154
- LADDER_A_OK
- **GO**

## Phase 5 staging webhook verification 2026-10-19

Staging gateway: `https://gateway-8gn7.onrender.com` (Render free plan, Neon Postgres).

`GET /healthz/deep` → HTTP 200 `{"db":"ok","paypalAuth":"ok","webhookSubscriptions":"ok"}`.

Real sandbox events from vault-spike run `20261019174023-6b7a` (`--reuse`), delivered by PayPal to
`/webhooks/paypal` and verified with `POST /v1/notifications/verify-webhook-signature`. Read from
the staging `webhook_events` table (`received_at` is database time):

| event_type | verification | received_at (UTC) |
| --- | --- | --- |
| PAYMENT.CAPTURE.COMPLETED | SUCCESS | 2026-10-19T17:44:47.658Z |
| PAYMENT.AUTHORIZATION.CREATED | SUCCESS | 2026-10-19T17:44:46.939Z |
| PAYMENT.CAPTURE.COMPLETED | SUCCESS | 2026-10-19T17:44:41.355Z |
| PAYMENT.AUTHORIZATION.CREATED | SUCCESS | 2026-10-19T17:44:41.052Z |
| PAYMENT.AUTHORIZATION.CREATED | SUCCESS | 2026-10-19T17:44:36.990Z |
| PAYMENT.AUTHORIZATION.CREATED | SUCCESS | 2026-10-19T17:44:36.883Z |
| PAYMENT.AUTHORIZATION.VOIDED | SUCCESS | 2026-10-19T17:44:35.762Z |

- Since 17:39 UTC: 7 rows, all `SUCCESS`, none `FAILURE`. That is orders A–D authorized (4 CREATED),
  A and C captured (2 CAPTURE.COMPLETED) and B voided (1 VOIDED).
- `processed_at` is NULL and `attempts` keeps rising (21–23 at read time): the spike created these
  orders outside Two-Key, so staging has no `payments` rows for them and the processor reports
  `no_payment`. That is expected. Retries stop at `MAX_WEBHOOK_ATTEMPTS` (60).
- The local clock was about 3 min 50 s behind database and PayPal time during this run.
- The `--reuse` run no longer replaces the honor-period test: `spikes/results/honor.json` was
  restored to authorization 93927348PL797874L (created 2026-10-19T14:07:27Z, which is its
  expiry 2026-11-17T14:07:27Z minus 29 days). `npm run spike:honor` runs after
  2026-10-22T15:07:27Z (20:37 IST).

## Phase 7 product-path payee verification 2026-10-20

Orders created by `npm run e2e:purchase` (gateway product path, real sandbox, local DB), then
fetched back from PayPal with the `packages/paypal` wrapper's `getOrder`.

| Proposal | Merchant | Local state | PayPal order | Order status | `purchase_units[0].payee.merchant_id` | Payment status | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Cloud Runner CR-1, $54.00 | stride-supply | captured | 5L537972F06439239 | COMPLETED | AYT4UTUV3UERE (Stride Supply) | captures[0] COMPLETED | MATCH |
| Trail Runner TR-2, $64.40 | peak-outfitters | held | 8LJ743018L229433A | COMPLETED | 8C4RBQX4U6BYL (Peak Outfitters) | authorizations[0] CREATED | MATCH |

- Both payees equal the registry IDs in `config/merchants.json`; the agent never supplies a payee.
- The $189 GiftVault gift card proposal (01a1573f-f5ba-73a7-90d0-6e8c45131740) has a G4
  `block` decision (`gates-v1`, first failing rule `merchant_allowlist`; also `per_item_cap`,
  `per_order_cap`) and no `payments` row: no PayPal order was created.

## Phase 9 authorization-expiry mock check 2026-10-20

`npm run spike:expiry` (real sandbox): vaulted $1.00 authorization at Stride Supply, then
`POST /v2/payments/authorizations/{id}/capture` with
`PayPal-Mock-Response: {"mock_application_codes":"AUTHORIZATION_EXPIRED"}`.

| Step | Result |
| --- | --- |
| Authorization | 0PJ5308318124953G (order 7AL63618J8848180G), CREATED |
| Capture with mock header | HTTP 422, name `UNPROCESSABLE_ENTITY`, issues `AUTHORIZATION_EXPIRED`, debug_id `70c28ae654da` |
| Issue descriptions | AUTHORIZATION_EXPIRED: An expired authorization cannot be captured. |
| Void afterwards | PayPal 403: NOT_AUTHORIZED / PERMISSION_DENIED; authorization status CREATED |
| Outcome | **expired** |

- PayPal simulates the expired-authorization capture on this endpoint. The gateway maps it to `expired` with no retry (`captureHeld`), and lifecycle test (6) uses the same body shape.

## Phase 9 hold lifecycle against the sandbox 2026-10-20 — third-party void is DENIED

`npm run e2e:purchase` (user e2e@twokey.demo), then `POST /human/approvals/:id` on the running
gateway with an assertion from `scripts/mint-assertion.ts`.

| Hold (TR-2, $64.40, payee Peak Outfitters 8C4RBQX4U6BYL) | PayPal call | Result | Local state |
| --- | --- | --- | --- |
| approval 01a158fd-4308-…, authorization 56Y81711FH049664U | capture | 201 COMPLETED, capture 5A923343PK334191X | held → captured, approval approved/web; second approve 409 "Already decided"; `openAuthorizations` 1 → 0 |
| approval 01a158fe-96e3-…, authorization 7HN92471117681234 | void | **403 NOT_AUTHORIZED / PERMISSION_DENIED** (debug_id ca4d794bfbf33) | held → void_requested (stays; no money moved) |

- The spike authorization above (payee Stride Supply) gave the same 403 on void.
- Retrying both voids with a `PayPal-Auth-Assertion` header (`iss` = our client ID, `payer_id` =
  the payee) returned 400 `invalid_request` "No permissions to set target_client_id": the app
  has no third-party (partner) permissions on the merchant accounts.
- The phase 2 void (order B) worked because its payee was the platform account itself
  (VV4V2YAUNBQHJ). No earlier test voided a third-party-payee authorization.
- So, as configured, the platform can **capture** but not **void** an authorization whose payee is
  a registry merchant. Deny and hold timeout therefore end in `void_requested` with the
  authorization still CREATED at PayPal (it lapses on its own after 29 days; nothing is charged).
  This needs a decision before the hold demo (invariant 11).
