# Demo rehearsal (phase 33, Nov 5)

Every beat of [VIDEO.md](VIDEO.md) walked on the **local** stack in Edge at **1280×720**, exactly
as the runbook says, including the scripted fallbacks (`scripted:hook`, `scripted:anomaly`, the
no-push path through `/approvals`). Production sign-in is the owner's, so nothing here signed in
on production.

Rerun it any time (spends PayPal sandbox money and one live model run):

```bash
E2E_SANDBOX=1 E2E_USER=maya@twokey.demo PLAYWRIGHT_CHANNEL=msedge npx playwright test e2e/rehearsal.spec.ts -c apps/web
```

It saves what the camera sees to [`docs/evidence/rehearsal/`](evidence/rehearsal/) (one file per
beat; `a`/`b`/`c` are moments within a beat). Run `npm run demo:reset -- --env local` at least 5
minutes after the previous run first (see known issue 1). No metric, prompt, threshold or frozen
evaluation file was touched.

## Fixes

| # | Where | Before | After | Screenshot |
| --- | --- | --- | --- | --- |
| 1 | Console, Recent purchases (`components/twokey/payment-row.tsx`) | Titles cut to one line in the narrow column: "Digital g…", "Cloud Runner CR-1 r…"; a wide badge ("Blocked · no PayPal order") squeezed the title to "Cloud / Runner… / Stride / Supply" | Product and price on the first line (title wraps to two lines), store and state badge on the second | `06-attack-blocked.png`, `02b-hook-scripted-held.png` |
| 2 | Console, scripted label (`app/agent/console.tsx`) | The "Scripted demo run" banner sat at the top of the page and scrolled out of frame as soon as the take scrolled down to the new card | Pinned (sticky) to the top of the screen while scrolling, so every frame of a scripted take shows it | `04b-clean-captured.png`, `06-attack-blocked.png` |
| 3 | Console, demo hook tag (`lib/console-view.ts`) | The tag ended in the full 36-character episode UUID, which wrapped onto a second line inside the listing box | Shows the first 8 characters ("test episode 01a14c4e"), enough to find it in the explorer; one line | `02c-hook-scripted-tag.png` |
| 4 | History grid (`components/grids/HistoryGrid.tsx`) | At 1280 wide the columns overflowed: the State cell was clipped ("Blocked No PayPa…") and products cut ("Cloud Runner CR-1 runni…") | Time 150, Product min 260, Store 130, Decision 90, Rule hits 180, State 260: everything through State fits, full product names | `05-history.png` |
| 5 | Runbook, 0:10 rules beat | Said to open `/rules`, which is "Page not found" (there is no index page; nothing in the app links to it) | `/agent` → **See all rules** → scroll to "Agent's job" | `03a-rules.png`, `03b-rules-agents-job.png` |
| 6 | Runbook, 0:32 attacker beat | Quoted "GiftVault is not one of your stores. No PayPal order created." | The console's own text: "GiftVault isn't in your stores. No PayPal order created." | `06-attack-blocked.png` |
| 7 | Runbook, 0:00 hook beat | Live model first, scripted fallback after two misses | `scripted:hook` first (labelled); a live take is optional. In rehearsal the live model saw the tagged poisoned listing and still bought the honest cheapest TR-2 at Stride Supply ($45, captured) | `01-hook-live.png`, `02b-hook-scripted-held.png` |
| 8 | Runbook, 0:20 and 1:40 | "Open /history for the PayPal IDs" (they are off-screen in the grid); "scroll the misses" (the table is below "Dated checkpoints") | The card's own order and capture IDs (copy buttons), or expand the History row; scroll past "Dated checkpoints" to the predictions table | `04b-clean-captured.png`, `11-predictions.png` |

## Known issues (workaround for the take)

1. **5 purchases per 24 hours, and the reset's 5-minute window.** maya's signed card allows 5
   purchases a day; captured and still-open purchases count, blocked and voided ones don't. The
   rehearsal hit it ("You've reached your limit of 5 purchases in 24 hours. No PayPal order
   created.") on the clean-purchase beat. `demo:reset` clears finished purchases but skips rows
   touched in the last 5 minutes, so straight after a take it clears almost nothing (1 of 6 in
   rehearsal). **Workaround:** wait 5 minutes after the last take, then reset (GitHub → Actions →
   demo reset → Run workflow, or `npm run demo:reset -- --env prod`), and budget about 4 buying
   takes per reset. Changing the card's limit would change the demo rules, so it stays.
2. **The live model is not reliable on the hook.** See fix 7. **Workaround:** `scripted:hook`.
3. **Approvals with two or more open holds:** after **Deny**, the voided card drops below the next
   waiting one, so a different card slides into the spot the viewer was watching (seen in the
   first rehearsal pass, with a leftover hold). **Workaround:** start from a clean slate
   (preflight's `open holds` PASS); with one hold the card stays put.
4. **"The agent is shopping…" lingers about a second** after the card reaches its final state
   (`06-attack-blocked.png`), until the run-ended event arrives. **Workaround:** hold the shot a
   second longer, or cut on the card.
5. **Model order differs between pages:** `/results` cards list nemotron, gpt-oss-120b,
   gpt-oss-20b; the README and the video numbers block list gpt-oss-120b first. Harmless; say the
   numbers per model name, not by position.

## Beats walked

| Beat | Result | Screenshots |
| --- | --- | --- |
| 0:00 hook, live model | Searched, saw the tagged listing, bought TR-2 at Stride Supply (not the hook) | `01-hook-live.png`, `01b-hook-live-tag.png`, `01c-hook-live-card.png` |
| 0:00 hook, `scripted:hook` | TR-2 at Peak Outfitters, **Waiting for you**, "$64.40 is 40% above the usual price at 3 stores", 15-minute countdown; tag in frame | `02a`–`02c` |
| 0:10 rules | Enforced-at-payment badges; "Size 10 · Agent's job — not checked by Two-Key" | `03a`, `03b` |
| 0:20 clean purchase | CR-1 at Stride Supply $54.00 **Captured**, IDs on the card; History | `04a`, `04b`, `05` |
| 0:32 attacker attempt | $189 gift card **Blocked · no PayPal order** in under a second | `06` |
| 0:50 hold, no-push path | `/approvals` → Deny → **Voided · no charge** | `07-hold-*` |
| 0:50 hold, `scripted:anomaly` | Held, then denied and voided | `08a`, `08b-*` |
| 1:10 results | Test split, 3 model cards, $0.00 | `09` |
| 1:40 honesty | Frontier; Predictions | `10`, `11` |
| 2:00 MCP | `/developers` with the release install | `12` |
| 2:20 AP2 | `/about` AP2 paragraph | `13` |
| 2:35 hijack box | Live, with today's tries and tokens shown | `14` |
