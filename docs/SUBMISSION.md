# Submission checklist

Devpost: "Build What's Next with PayPal and AI". Deadline **Nov 12, 2026, 12:00 PT** (Nov 13,
01:30 IST). Our hard stop: **Nov 12, 18:00 IST**. Plan: video locked Nov 8, submit Nov 11.

Tick each box in this file as it is done; commit the ticks.

## Repository

- [ ] `README.md`: `<DEMO_PASSWORD>` filled (`~/two-key-secrets/demo-password.txt`), then
      `node scripts/readme-results.ts --check` passes.
- [ ] Repository public; README renders on GitHub (GIF, architecture diagram, CI badge green).
- [ ] Release `v1.0.0` has `twokey-mcp-1.0.0.tgz`; the README's `npx -y …` line installs it
      (`npm run mcp:pack-smoke`).
- [ ] `npm run check` exits 0 on `main`; `release` = `main`; CI green on both.

## Production (https://web-ycyg.onrender.com)

- [ ] `npm run preflight -- --env prod` ends `GO` on the day of recording and the day of
      submission.
- [ ] Gateway and MCP `/healthz` show the release commit; web and agent-runner deploys show it
      in Render → Events.
- [ ] Results explorer shows the test split: 900 runs, 3 models (preflight checks it).
- [ ] judge1 (the README account) signs in, has a wallet and the demo card; the console starts
      a run. Check in a private window with the demo password.
- [ ] Hijack box live with headroom today (preflight); its replay works when it is not.
- [ ] Daily demo reset ran in the last 24 hours (GitHub → Actions → demo reset).

## Video (docs/VIDEO.md)

- [ ] ≤ 2:55; follows the runbook; every number said or shown is in its generated block.
- [ ] No "held about half"; the $0.00 is never presented as blocks seen in the evaluation.
- [ ] Scripted runs carry the lower third "scripted agent"; any replay keeps its banner.
- [ ] Captions: `docs/video/captions.srt` uploaded with the video (retime to the final cut by
      editing `captions.template.srt` and rerunning `node scripts/readme-results.ts`).
- [ ] End card: `docs/video/end-card.png` (`npm run video:end-card`).
- [ ] No third-party trademarks or product images on screen (the explorer redacts brands).
- [ ] Uploaded public (YouTube or Vimeo), link opens in a private window.

## Devpost form (copy from docs/DEVPOST.md)

- [ ] Name, tagline ("Not a shopping agent. The lock on its wallet."), story sections.
- [ ] Try-it link: https://web-ycyg.onrender.com; code link:
      https://github.com/nirmalraj142007-byte/Two-key; video link.
- [ ] Images from DEVPOST.md "Images to upload" (frontier: the test-split screenshot).
- [ ] Judge sign-in: `judge1@twokey.demo` and the demo password, in the testing instructions
      field (not public text if the form offers a private field).
- [ ] Special awards as listed in DEVPOST.md. AG Grid prize only once its criteria are checked.
- [ ] Built-with tags match DEVPOST.md "Built with".
- [ ] Submitted before Nov 12, 18:00 IST; confirmation email saved.

## After submitting

- [ ] No pushes to `release` except fixes that keep the demo working; rerun preflight after any.
- [ ] Watch the hijack box caps and Render's free hours until judging ends.
