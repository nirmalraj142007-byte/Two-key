# Performance (phase 29)

Measured Nov 1, 2026 on the dev machine (Windows 11), local Postgres 16 in Docker, **while the test
evaluation was running** on ports 4010/4110/4210 against the same database. Numbers are therefore
conservative for the gateway and database. Rule followed: measure first, fix only what misses a
target. Nothing on the money path was changed or cached.

| # | Target | Before | After | Result |
| --- | --- | --- | --- | --- |
| 1 | Lighthouse mobile ≥ 90 on `/` and `/m/approve/<id>` | 99 and 98 | 98 and 98 | met, no fix needed |
| 2 | Shared first-load JS ≤ 180 KB gzip; AG Grid/Charts only in grid/chart routes | 189.9 KB | 163.4 KB | met after fix |
| 3 | Blocked decision p95 < 150 ms at 20 rps | 171.7 / 122.0 / 121.6 ms | 118.7 / 118.2 ms | met, no code change |
| 4 | Webhook → UI p95 < 2 s | 26 ms | 27 ms | met, no fix needed |
| 5 | Hijack median < 30 s | not measurable now (NIM timing out); last live runs 72.1 s | unchanged | **not met**, upstream model latency |
| 6 | Index only where a plan shows a seq scan over 10 ms | no plan over 10 ms | no migration | nothing to add |
| 7 | Results summary cached 60 s, 2nd request < 50 ms | 4–6 ms | 4–6 ms | met |

## 1. Lighthouse

`node scripts/perf-lighthouse.mjs` (production build on :3000, mobile, simulated throttling,
`--preset=perf`, 3 runs per page, median reported). Microsoft Edge is the only Chromium here, so the
script starts it on a fixed debugging port and Lighthouse attaches (Lighthouse's own launcher cannot
find Edge's dynamic port). `/m/approve/<id>` is behind sign-in: the script mints the same Auth.js
session cookie sign-in would, for the owner of the newest approval (a decided one; no hold was
pending), and fails if the page redirects to `/login`.

| Page | Before (3 runs) | After (3 runs) | FCP / LCP after | TBT after | CLS |
| --- | --- | --- | --- | --- | --- |
| `/` | 99, 99, 99 | 97, 98, 98 | 1.68 s / 1.68 s | 125 ms | 0.02 |
| `/m/approve/<id>` | 98, 98, 98 | 98, 99, 98 | 1.60 s / 1.65 s | 94 ms | 0 |

Both pages were already above 90, so nothing was changed for Lighthouse. The 1-point differences are
run-to-run noise. The CSP is untouched: pages still render per request so the nonce reaches every
script, and `'unsafe-inline'` / `'unsafe-eval'` are not allowed for scripts. `/` did not need to be
static.

## 2. Bundle

`npm run build -w @twokey/web`, then `node scripts/bundle-report.mjs` (gzips the chunks listed in
`.next/diagnostics/route-bundle-stats.json`).

- **Shared by every route: 189.9 KB → 163.4 KB gzip** (13 → 11 chunks).
- Cause: the root layout loaded the Radix tooltip provider and the Sonner toaster (with its icons) on
  every page, although only a few pages use either.
- Fix, no change in behaviour: `Tooltip` now brings its own provider (same 300 ms delay,
  `components/ui/tooltip.tsx`), and the root layout loads the toaster after hydration through
  `components/twokey/LazyToaster.tsx` (`next/dynamic`, `ssr: false`). Checked in the built app:
  the toaster mounts and a copy toast renders, with no console or CSP errors.
- AG Grid and AG Charts were already outside the shared bundle: they load only through `next/dynamic`
  from `app/history/live.tsx` (history grid), `components/results/EpisodesTable.tsx` (episodes grid)
  and `components/results/ResultsTabs.tsx` (charts), and no route lists their chunks in its first
  load.
- `@next/bundle-analyzer` is wired behind `ANALYZE=1` in `next.config.ts`, but Next 16 builds with
  Turbopack, which the webpack plugin cannot see. For a treemap of the Turbopack build use
  `npm run analyze -w @twokey/web` (`next experimental-analyze`).

Per-route first-load JS after (gzip): `/` 163 KB, `/about` 163 KB, `/results` and
`/results/episodes` ≈ 177 KB, `/developers` 179 KB, `/history` 205 KB, `/approvals` 209 KB,
`/m/approve/[id]` 208 KB, `/agent` 231 KB.

## 3. Blocked decision (gateway)

`npx tsx scripts/bench-blocked.ts` — `POST /agent/proposals` for the GiftVault gift card (the rule
card allows Stride Supply only, so it is blocked by `merchant_allowlist`; zero PayPal calls by
design), 20 rps for 30 s, 600 requests, all 200, 0 errors. The 30-per-minute per-session limiter
stays on: the script creates 60 throwaway agent sessions (10 requests each per minute) and removes
them, their proposals and the throwaway user afterwards. It refuses the eval gateway (port 4010).

| Run | p50 | p95 | p99 |
| --- | --- | --- | --- |
| before, run 1 | 104 ms | **171.7 ms** | 704 ms |
| before, run 2 (127.0.0.1) | 92 ms | 122.0 ms | 135.6 ms |
| before, run 3 | 91.7 ms | 121.6 ms | 139.5 ms |
| after, run 1 | 86 ms | 118.7 ms | — |
| after, run 2 | 83 ms | 118.2 ms | — |
| after, runs 3 and 4 (30 s) | 84 / 77 ms | 113.8 / 103.8 ms | — |
| 10 s run right after `npm run check` | — | 185.3 ms (FAIL) | — |
| 2 rps, unloaded | 23 ms | 35 ms | — |

- No gateway code was changed. Run 1 missed the target on its first pass (cold gateway, eval
  running); the 30 s runs since then sit at 104–122 ms; a short 10 s run started straight after the full test suite hit 185 ms, so a cold or busy machine can still miss, about 20% under the target. Treat the margin as
  moderate, not large.
- The benchmark targets `127.0.0.1`: on this Windows machine `localhost` tries `::1` first and adds
  about 200 ms to every new connection, which is the OS, not the gateway.
- Where the time goes: about 12 database round trips per proposal (token, listing, category median,
  rule card, a transaction with the per-user advisory lock, then the result rebuild) at about 1.5 ms
  each unloaded, so about 23 ms alone. At 20 rps all 600 requests belong to one user, so they queue
  on that user's advisory lock; requests of different users would not. That is why p50 rises to about
  85 ms under load.
- The suggested caches (verified rule card per session for 30 s) were **not** added. A card that is
  revoked or expires would keep authorizing for up to 30 s, which weakens an invariant for no
  needed gain. Changing `purchase.ts` was also avoided while the test evaluation runs on the same
  working tree.

## 4. Webhook → UI

`npx tsx scripts/bench-sse.ts` — subscribes to `GET /human/events` as a throwaway user, then ten
times inserts a verified `webhook_events` row and calls `applyWebhookEvent` (the webhook route's
code), measuring from before the apply transaction to the `payment.updated` frame arriving on the
stream (apply, `pg_notify`, the gateway's LISTEN hub, the view query, the write). Ten events:
p50 16–17 ms, **p95 26–27 ms**, max 27 ms (three runs). Includes the throwaway rows' cleanup.

## 5. Hijack box

`node scripts/bench-hijack.mjs 5` starts attempts through the public `POST /api/hijack` and measures
`hijack_attempts.created_at` to the session's `ended_at` (the table has no finish column).

**Not met, and not fixable from this repository today.** All five attempts today fell back to the
recorded replay after exactly 60 s (60.2, 60.4, 60.9, 60.2, 61.3 s): the live run's first model call
timed out (`UPSTREAM_LLM: Model call failed: Request timed out.`). A direct probe of NVIDIA NIM
`openai/gpt-oss-20b` with a 16-token prompt also timed out at 90 s (twice), so the provider is
throttling or queueing right now, probably because the test evaluation uses the same model and key
at about 35 requests/min. Those numbers are the 60 s fallback timeout, not live run times.

Live runs recorded on Oct 28 (11 completed live attempts, 5–6 started at the same moment, 6
transcript steps, 2.4–3.2k tokens each): median **72.1 s**, min 37.4 s, max 102.2 s. That is also over
30 s, and it is model latency (about three model calls at 10–30 s each on the free tier), not
gateway or web time. Reaching 30 s would mean a different model, provider or reasoning setting, which
changes behaviour and the evaluation's comparability, so nothing was changed. Re-measure after the
test split finishes and the provider is idle.

## 6. Queries

`node scripts/perf-explain.mjs` runs `EXPLAIN (ANALYZE, BUFFERS)` for each query on the local
database as it is now. Sizes: 2,205 dev gate decisions behind the results summary (2,997 rows in
`gate_decisions` in all while the test split still runs), 1,373 eval runs, 600 episodes, 2,859
listings. The 4,500-decision test split is not complete yet, so these are measured on what exists.

| Query | Execution | Seq scans |
| --- | --- | --- |
| history route (busiest user, 500 rows) | 1.4 ms | 0 |
| results summary: runs of a split | 0.7 ms | 3 (tables of 100–1,400 rows) |
| results summary: proposals + gate decisions (500 sessions) | 7.1 ms | 6 |
| results summary: test-run count | 0.4 ms | 3 |
| episodes route: episodes, run ids, listing titles | 0.1–0.6 ms | 1–2 |
| demo catalog search (ILIKE, two words) | 4.3 ms (steady) | 3 |
| blocked path: category median | 0.6 ms | 3 |

No plan has a sequential scan over 10 ms (the largest node, the ILIKE scan of `listings`, is about
4 ms), so **no index migration was added**. This also keeps the migration chain untouched while the
evaluation writes to the same database. If the catalog grows much past a few thousand listings, a
trigram index on `listings.title` and a `(snapshot_id, category)` index are the first candidates.

## 7. Results summary cache

`getResultsSummary` is `unstable_cache` with `revalidate: 60`. Production build, `GET
/api/results/summary`: first request after start 142 ms (computes the metrics from the database),
then 4.3, 3.9, 3.6, 5.0, 6.2 ms. After more than 60 s the stale value is served at once (3.9 ms) while
it refreshes in the background. Well under 50 ms. Payments and approvals are never cached.

## Reproduce

```bash
npx tsx scripts/bench-blocked.ts          # dev gateway on :4000
npx tsx scripts/bench-sse.ts
node scripts/perf-explain.mjs
npm run build -w @twokey/web && node scripts/bundle-report.mjs
node scripts/perf-lighthouse.mjs          # prod web on :3000 (npm run start -w @twokey/web)
node scripts/bench-hijack.mjs 5           # uses model tokens; needs web, gateway, mcp, runner
```
