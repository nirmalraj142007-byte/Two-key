# Submission checklist

Devpost: "Build What's Next with PayPal and AI". Deadline **Nov 12, 2026, 12:00 PT** (Nov 13,
01:30 IST). Our hard stop: **Nov 12, 18:00 IST**. Plan: video locked Nov 8, submit Nov 11.

Tick each box in this file as it is done; commit the ticks.

## Status (Nov 6)

Production: `npm run preflight -- --env prod` → **GO** (0 FAIL; WARN: maya has no push alerts;
MANUAL: `ALLOW_SCRIPTED`); all four services on the release commit. `npm run smoke -- --env prod`
→ **8 of 9** (`tools/list` needs `SMOKE_AGENT_TOKEN`).

Left, in order:

1. ~~Demo reset workflow~~ **fixed Nov 6.** It failed Nov 3–5 (missing merchant credentials
   secret); then a `PROD_RULE_HMAC_KEY` that differed from the gateway's made it re-sign every card
   with the wrong key (restored the same hour with `demo:setup`). Secrets re-entered; the reset now
   refuses to sign when no card verifies with its key. Manual run Nov 6 05:42 UTC: green, preflight
   GO afterwards.
2. **Render:** `ALLOW_SCRIPTED=true` on web and agent-runner; gateway `HIJACK_PAYPAL_*` set and
   `PAYPAL_CLIENT_ID` = the sandbox app in `.env.gateway`.
3. ~~judge2 and judge3 wallets~~ **done Nov 6:** judge1–3 each have an active wallet and a card
   that verifies with the gateway key; README and DEVPOST list all three.
4. **Production smoke 9 of 9:** sign in, create an agent token at /onboarding/agent, then
   `SMOKE_AGENT_TOKEN=tk_agent_… npm run smoke -- --env prod` (with the four `SMOKE_*_URL`s from
   docs/DEPLOY.md).
5. **Reset void step on a real hold:** docs/DEMO.md, "Not yet exercised" (needs item 1).
6. **Rollback drill:** docs/DEPLOY.md, "Rollback drill log".
7. **maya's push alerts** (optional): docs/VIDEO.md, "Before recording", step 3.
8. **Record** (docs/VIDEO.md), **upload to YouTube** (public), **fill the Devpost form** (below).

## Devpost video rules

- **Under 3 minutes.** Our cut is ≤ 2:55.
- **Public on YouTube** (not unlisted or private), and the link opens in a private window.
- **No third-party trademarks** on screen (fictional sandbox stores only; the explorer redacts
  brand names) and **no copyrighted music**: silence, our own voice-over, or a track whose licence
  allows it.

## Repository

- [x] `README.md`: `<DEMO_PASSWORD>` filled for the judge accounts (maya has her own password,
      never published); `node scripts/readme-results.ts --check` passes (Nov 5).
- [x] `LICENSE` (MIT) at the root, so GitHub shows it in the About section (Nov 6).
- [x] Repository public (Nov 6).
- [ ] README renders on GitHub (GIF, architecture diagram, CI badge green): look once in a private
      window.
- [x] Release `v1.0.0` has `twokey-mcp-1.0.0.tgz` (Nov 6); the README's `npx -y …` line installs
      it (`npm run mcp:pack-smoke`).
- [x] `npm run check` exits 0 on `main`; `release` = `main`; CI green (every release so far).

## Production (https://web-ycyg.onrender.com)

- [ ] `npm run preflight -- --env prod` ends `GO` on the day of recording and the day of
      submission (GO on Nov 6).
- [x] All four `/healthz` show the release commit (preflight and smoke check it; URLs in
      docs/DEPLOY.md).
- [x] Results explorer shows the test split: 900 runs, 3 models.
- [x] judge1, judge2 and judge3 each have an active wallet and the demo card, verified with the
      gateway key (Nov 6).
- [ ] One judge account signs in and the console starts a run: check in a private window with
      the published password.
- [x] Hijack box live with headroom today (Nov 6: 200 attempts, 150,000 tokens).
- [x] Daily demo reset ran in the last 24 hours (GitHub → Actions → Demo reset): green on Nov 6;
      check it again on recording day.

## Video (docs/VIDEO.md)

- [ ] Under 3 minutes (our cut ≤ 2:55); follows the runbook; every number said or shown is in
      its generated block.
- [ ] No "held about half"; the $0.00 is never presented as blocks seen in the evaluation.
- [ ] Every scripted run keeps the console's "Scripted demo run" label in frame; any replay keeps
      its banner.
- [ ] Captions: `docs/video/captions.srt` uploaded with the video (retime to the final cut by
      editing `captions.template.srt` and rerunning `node scripts/readme-results.ts`).
- [ ] End card: `docs/video/end-card.png` (`npm run video:end-card`).
- [ ] No third-party trademarks or product images on screen; no copyrighted music.
- [ ] Uploaded public on YouTube; link opens in a private window.

## Devpost form (copy from docs/DEVPOST.md)

- [ ] Name, tagline ("Not a shopping agent. The lock on its wallet."), story sections.
- [ ] Try-it link: https://web-ycyg.onrender.com; code link:
      https://github.com/nirmalraj142007-byte/Two-key; video link.
- [ ] Images from DEVPOST.md "Images to upload" (frontier: the test-split screenshot).
- [ ] Judge sign-in: `judge1@twokey.demo`, `judge2@twokey.demo`, `judge3@twokey.demo` and the
      published password, in the testing instructions field (also in the README and DEVPOST.md).
- [ ] Special awards as listed in DEVPOST.md: Best Use of Agentic Commerce, Best Use of
      PayPal + AI, Most Impactful. Not the AG Grid prize (it targets AG Studio).
- [ ] Built-with tags match DEVPOST.md "Built with".
- [ ] Submitted before Nov 12, 18:00 IST; confirmation email saved.

## After submitting

- [ ] No pushes to `release` except fixes that keep the demo working; rerun preflight after any.
- [ ] Watch the hijack box caps and Render's free hours until judging ends.
