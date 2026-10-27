# Phase 19 evidence: history and merchants

Recorded 2026-10-27 on the local dev stack (web 3000, gateway 4000), real PayPal sandbox,
Microsoft Edge driven by Playwright, signed in as e2e@twokey.demo.

## Purchases

`npm run e2e:purchase`:

```text
Cloud Runner CR-1 running shoe  stride-supply    captured  captured  order 7WP003825U5574453  capture 1V36804527121790U
Digital gift card $189          giftvault        blocked   -         GiftVault isn't in your stores. No PayPal order created.
Trail Runner TR-2 running shoe  peak-outfitters  held      held      authorization 5C708806WR520131P
                                Held for your approval: $64.40 is 40% above the usual price at 3 stores.
```

## /history

- `history.png`: grouped by state, the TR-2 row expanded to its payment-event timeline
  (API response ×3, Human, API response), no watermark (0 watermark elements in the DOM).
- Live update: with /history open, the hold was approved in a second tab. Without a reload,
  "Open authorizations" went 1 → 0 after 4.3 s and the TR-2 row changed to Captured
  (`history-after-approve.png`, grouped by store).

## /merchants

`merchants.png`: GiftVault (Attacker (sandbox)) $0.00; Stride Supply shows the funds it
received through Two-Key. Every card is labelled "computed from Two-Key records": PayPal
answered `GET /v1/reporting/balances` with HTTP 403 for all four merchant apps in
`MERCHANT_API_CREDENTIALS` (debug IDs f402102a48d87, f402102ad4729, f402102bbe64c,
f402102cdc453), and GiftVault has no credentials. The main figure is gross captured; PayPal's
net balance would show beneath it if PayPal reported one.

## AG Grid

`NEXT_PUBLIC_AG_GRID_LICENSE_KEY` is not set, so the grid runs Community features only and
Enterprise code is never downloaded. Skipped Enterprise features and their Community stand-ins:

| Enterprise feature | Community stand-in |
| --- | --- |
| Row grouping (`RowGroupingModule`) | Group-by toggle builds full-width group header rows (count and total), collapsible |
| Master/detail (`MasterDetailModule`) | Expand button inserts a full-width detail row with the payment-event timeline |
| Column menu, sorting inside groups | Rows stay newest first; sorting is off in the fallback |

With a key set, `lib/ag-grid.ts` loads and licenses both modules and the grid switches to the
Enterprise row grouping and master/detail. That path typechecks but was not run (no key).

## Bundle

Next.js 16 (Turbopack) no longer prints per-route First Load JS, so the sizes below were
computed from `.next` after `npm run build -w @twokey/web` (rootMainFiles plus each page's entry
chunks from its client reference manifest, gzip):

```text
Shared first-load JS (rootMainFiles, gzip): 129.8 kB  contains AG Grid: no
Route                                Route JS  First load  AG Grid in first load
/agent/page                           90.0 kB    219.8 kB  no
/approvals/page                       88.6 kB    218.4 kB  no
/history/page                         86.2 kB    216.0 kB  no
/merchants/page                       84.8 kB    214.6 kB  no
/page                                 45.3 kB    175.1 kB  no

AG Grid chunks (lazy, loaded by next/dynamic on /history only):
  static/chunks/1o8d_6krxxla2.js  201.4 kB gzip   (ag-grid-enterprise; only with a licence key)
  static/chunks/3c7iiwpqdhcmi.js   22.0 kB gzip   (HistoryGrid + ag-grid-react)
  static/chunks/3stqxnxsnbb8f.js  301.0 kB gzip   (ag-grid-community)
```
