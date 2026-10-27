# Phase 18 evidence: approvals and phone PWA

Recorded 2026-10-27 on the local dev stack (web 3000, gateway 4000), real PayPal sandbox,
Microsoft Edge driven by Playwright (persistent profile, notifications granted for
http://localhost:3000).

1. Signed in as e2e@twokey.demo, opened /approvals, clicked "Turn on alerts".
   Toggle: "On. This device gets a notification when a purchase is held."
   `push_subscriptions` rows for e2e@twokey.demo: 1.
2. `npm run e2e:purchase`:

   ```text
   Cloud Runner CR-1 running shoe  stride-supply    captured  captured
   Digital gift card $189          giftvault        blocked   -   GiftVault isn't in your stores. No PayPal order created.
   Trail Runner TR-2 running shoe  peak-outfitters  held      held   approval 01a17d31-06dc-7a28-960c-3b07483c9501
                                                    authorization 081634077S712452T
                                                    Held for your approval: $64.40 is 40% above the usual price at 3 stores.

   push: 1 device(s), push service HTTP 201
   ```

   `push_subscriptions.last_ok_at` = 2026-10-27 11:48:47.913+00 (subscription created 11:47:34).
3. 390×844 viewport, /m/approve/01a17d31-06dc-7a28-960c-3b07483c9501, tapped Deny:
   - before: [phone-approval-before.png](phone-approval-before.png) ("Waiting for you", 14:24 left)
   - after: [phone-approval-after.png](phone-approval-after.png) ("Voided · no charge")
   - approval `denied` via `phone`, payment `voided`; events: void.requested and void.completed
     with `tk-01a17d30-fe54-727e-a402-9ee982ef0d70-void`, then reconcile.confirmed.
   - platform `GET /v2/payments/authorizations/081634077S712452T` → 200, status `VOIDED`,
     64.40 USD.
4. /approvals after the deny: "Nothing waiting for you", 0 cards
   ([inbox-empty-after-deny.png](inbox-empty-after-deny.png)).

Not recorded here: the Android phone + scrcpy take (manual, for the video).
