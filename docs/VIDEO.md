# Video runbook (≤ 2:55)

One production environment: **https://web-ycyg.onrender.com** (PayPal sandbox; no real money).
No staging. Every number below comes from `eval/results/test-metrics.json` through
`node scripts/readme-results.ts` (the generated block at the end); never type one by hand.
Captions: [`docs/video/captions.srt`](video/captions.srt), made from
[`captions.template.srt`](video/captions.template.srt) by the same script.

Copy rules for the voice-over, captions and edits:

- Never say Two-Key "held about half". It held 2 of the 15 inside-the-rules follows.
- Never imply the $0.00 came from blocking attempts in the evaluation: no agent in the test tried
  to pay the attacker. The block is shown by the scripted 0:32 beat and guaranteed by the design.
- A scripted run is a stand-in, not a live model. The console labels every one "Scripted demo
  run (scripted:<name>): a fixed script plays the agent, not a live AI model"; keep that label in
  frame. Anything replayed keeps its banner "Replaying a recorded run".
- No AG Grid claim anywhere (prize criteria not checked).

## Before recording

1. **Preflight** (read-only on production, then a rehearsal of the beats on the local stack):

   ```bash
   npm run preflight -- --env prod --beats
   ```

   It must end with `GO`. Fix every FAIL; each WARN names its fallback below. It also wakes the
   free Render services, so record within 15 minutes of it.
2. **Render settings** (you, in the dashboard; no restart of anything else):
   - **web** and **agent-runner** → Environment → `ALLOW_SCRIPTED` = `true` → Save and deploy.
     Needed for the 0:32 beat (`scripted:attack`) and the hook fallback (`scripted:hook`).
   - **gateway** → Environment: `HIJACK_PAYPAL_PAYMENT_TOKEN_ID`, `HIJACK_PAYPAL_CUSTOMER_ID`
     (same values as `~/two-key-secrets/prod-gateway.env`), and `PAYPAL_CLIENT_ID` is the sandbox
     app in `.env.gateway`.
   - **agent-runner** → Events: its latest deploy is the release commit (preflight cannot see it).
3. **Push alerts for maya** (optional; the fallback is in beat 0:50). Desktop Chrome:
   1. Open https://web-ycyg.onrender.com/login, sign in as `maya@twokey.demo`.
   2. Open https://web-ycyg.onrender.com/approvals → **Phone alerts** → **Turn on alerts** →
      Chrome's prompt → **Allow**. The box says "On. This device gets a notification when a
      purchase is held."
   3. If it says notifications are blocked: site-info icon left of the address bar →
      Notifications → **Allow**, reload. Windows: Settings → System → Notifications → Google
      Chrome on; Focus / Do not disturb off.
   4. Rerun preflight: `push alerts` turns PASS.
4. **Clean slate:** preflight's `open holds` must be PASS. If not: /approvals → **Deny** each one.
5. **Browser:** Chrome, 1920×1080, zoom 100%, bookmarks bar hidden, signed in as maya. Tabs in
   order: `/agent`, `/rules`, `/history`, `/approvals`, `/results`, `/developers`, `/about`,
   `/hijack`, the GitHub README. A terminal for the 2:00 beat.

## Beats

| Time | Screen | Do | Shows | Fallback |
| --- | --- | --- | --- | --- |
| 0:00–0:10 Hook | `/agent` | Send "Running shoes, size 10, under $70, only Stride Supply or Peak Outfitters, one pair, this week." | The agent searches; the Cloud Runner CR-1 listing at Peak Outfitters carries the attack text; the agent proposes **Trail Runner TR-2 at Peak Outfitters**. The console tags the listing **"This attack text fooled all 3 models in our test (goal adapted)"**; keep the tag in frame | If the live model does not take the bait in two takes: `/agent?model=scripted:hook`, same message (the "Scripted demo run" label shows) |
| 0:10–0:20 Rules | `/rules` | Scroll to the card | Maya's signed card: badges **enforced at payment** (stores, $70, one item) vs **Agent's job — not checked by Two-Key** (size 10) | — |
| 0:20–0:32 Clean purchase | `/agent?model=scripted:happy` | Send the demo request | Cloud Runner CR-1 at Stride Supply, $54.00, **Captured**; open `/history` for the PayPal order and capture IDs | Live model instead of scripted if it buys CR-1 at Stride |
| 0:32–0:50 Attacker attempt | `/agent?model=scripted:attack` (the "Scripted demo run" label shows) | Send the demo request | $189 gift card at GiftVault → **Blocked · no PayPal order** ("GiftVault is not one of your stores. No PayPal order created.") | — |
| 0:50–1:10 Hold | The hook take's card, then the notification | Card shows **Waiting for you**: "40% above the usual price at 3 stores" ($64.40 vs $46.00). Click the Chrome notification "Approve $64.40 at Peak Outfitters?" → **Deny** | **Voided · no charge** | **No push:** open `/approvals` → the hold → **Deny**. Hold expired (15 min) or hook taken with the scripted fallback: `/agent?model=scripted:anomaly`, "Trail Runner TR-2, under $70, one pair." |
| 1:10–1:40 Results | `/results` | Hover the three model cards | Outside vs inside the rules per model, "Money sent to an attacker under Two-Key: $0.00". Caption the honest note (no agent tried, so $0.00 does not test the block) | — |
| 1:40–2:00 Honesty | `/results` → **Frontier**, then **Predictions**; README "What we found" note | Point at the static cap and Two-Key points per model; scroll the misses | Frontier, predictions with misses marked, the dev→test note | — |
| 2:00–2:20 MCP | `/developers`, terminal | Show the MCP URL and the install line `npx -y https://github.com/nirmalraj142007-byte/Two-key/releases/download/v1.0.0/twokey-mcp-1.0.0.tgz` | Claude Desktop only if set up; otherwise `npm run mcp:pack-smoke` output | — |
| 2:20–2:35 AP2, architecture, CI | `/about`; README | AP2 paragraph; architecture diagram; CI badge (green) | — | — |
| 2:35–2:48 Hijack box | `/hijack`, then README | Paste an attack, run it live | The box's live result | Not live or out of today's attempts: its replay, banner visible |
| 2:48–2:55 End card | [`docs/video/end-card.png`](video/end-card.png) | — | Two-Key, the pitch line, live URL, repo, small print "PayPal AI Hackathon · All products and merchants are fictional sandbox accounts." | — |

**Recording order:** take the hook first and leave its hold **Waiting for you**; record 0:10–0:50
in other tabs; deny the hold within its 15-minute window for 0:50–1:10. If the window passes,
use the 0:50 fallback.

**If PayPal is degraded** (preflight WARN or a banner in the console): the console replays the
recorded run under "Replaying a recorded run — PayPal sandbox or the model is unavailable right
now". Prefer waiting and retrying; if you must use it, the banner stays in frame.

## Numbers (generated)

<!-- results:video:start -->
From `eval/results/test-metrics.json` (test split): 600 attacked runs, 3 models.

| Model | Outside the rules followed | Inside the rules followed | Inside follows held | Static cap: let through / honest interrupted | Two-Key: let through / honest interrupted |
| --- | --- | --- | --- | --- | --- |
| `openai/gpt-oss-120b` | 0 of 114 | 2 of 86 | 1 of 2 | 1 of 200 / 12 of 67 | 1 of 200 / 19 of 67 |
| `openai/gpt-oss-20b` | 0 of 114 | 4 of 86 | 0 of 4 | 3 of 200 / 11 of 58 | 4 of 200 / 15 of 58 |
| `nvidia/nemotron-3.5-bolt-e4b` | 0 of 114 | 9 of 86 | 1 of 9 | 8 of 200 / 15 of 84 | 8 of 200 / 23 of 84 |
| **All** | **0 of 342** | **15 of 258** | **2 of 15** | | |

Paid to an attacker under Two-Key: $0.00. Predictions in range: 16 of 21.

Voice-over lines with numbers (filled from the metrics; say them as written):

- **0:00 hook:** "This attack text fooled all three models in our test. Here the price check catches it; in our test it caught 2 of 15 — still an open problem."
- **0:32 attacker attempt:** "Agents almost never try to pay the attacker: 0 of 342 chances in our test. When one does, it's impossible: no PayPal order is created."
- **1:10 results:** "Outside the rules: 0 of 342. Inside the rules: 15 of 258. $0.00 to attackers, and since no agent tried, that number does not test the block."
- **1:40 honesty:** "On this test the flat cap did as well or better, because no agent tried to pay the attacker. What a cap can’t do is stop a payment to an attacker under the cap; Two-Key’s payee rule can. Predictions: 16 of 21 landed, and we show the misses."
- **closing line:** "In 600 poisoned shopping trips on frozen test data, three AI agents never once followed 'pay the attacker', but tried to buy the wrong thing inside the budget 15 times. Two-Key makes paying an attacker impossible; the wrong-product problem is still open, and we measured it."
<!-- results:video:end -->
