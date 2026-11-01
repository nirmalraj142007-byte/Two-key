# Decisions

## 2026-10-31 — LLM cost and spend caps (W22)

Confirmed by the team on 2026-10-31.

- **All model use is on free tiers.**
  - Groq free tier: `openai/gpt-oss-120b` (test-split evaluation), `openai/gpt-oss-20b` (live agent,
    from Nov 1) and `qwen/qwen3.8-27b` (rule
    compiler until the test split is done).
  - NVIDIA NIM free tier: `openai/gpt-oss-20b` (evaluation and
    the LLM grader) and `nvidia/nemotron-3.5-bolt-e4b` (evaluation, weak model).
- **No paid LLM console is used, so there are no console spend caps to set.** The limits that
  apply are the providers' own free-tier rate limits, plus our own: the hijack box's daily caps on
  attempts (`HIJACK_DAILY_ATTEMPTS`) and tokens (`HIJACK_DAILY_TOKENS`), and the evaluation's Groq
  pacing (`eval/src/ratelimit.ts`).
- ANTHROPIC_API_KEY is a placeholder; no Anthropic model is called anywhere in the product (Claude
  Code was used only as the development tool).
- **Total LLM cost recorded: $0.00.** Every `eval_runs.cost_usd` is 0 (checked 2026-10-31: dev
  600 runs, test 739 runs so far). Prices come from `apps/agent-runner/src/pricing.ts`, which
  records each model's source: "Groq free tier, 2026-10-25" and "NVIDIA NIM free tier,
  2026-10-26" (0 USD per million input and output tokens). The `/results` footer shows the total
  from `computeMetrics()` (`totals.totalCostUsd`).

## 2026-10-31 — Evaluation isolation: live work moves to `.live` queues

**Question.** Did any test-split evaluation run since Oct 26 execute on a dev-stack runner instead
of the evaluation stack's runner (4210)?

**Finding: no, and it could not have.** The premise (that evaluation jobs go through the
`agent.run` queue) was wrong. `eval run` calls `runSession()` in its own process
(`eval/src/run.ts`): it creates the session at the evaluation gateway, runs the model loop itself
and writes `eval_runs`. It never enqueues a pg-boss job, and the evaluation stack's runner on 4210
never sees these runs. Checked in the dev database on 2026-10-31:

- 0 of the `eval_runs` sessions appear as a `sessionId` in any `pgboss.job` row.
- 0 jobs in `pgboss.job` belong to a session with `mode = 'eval'`; every `agent.run` job (17,
  Oct 26 to Oct 31) has `mode: demo`. The 1,800 `mode = 'eval'` sessions have no job.
- Every `eval_runs` row points at a session with `mode = 'eval'`.
- Test-split runs since Oct 26 (the full test split so far): `nvidia/nemotron-3.5-bolt-e4b` 300,
  `openai/gpt-oss-20b` 300, `openai/gpt-oss-120b` 160. Dev-split: 300 each for the two NIM models.
  Executed by a dev-stack runner: 0 for every model.

Limit of this evidence: pg-boss deletes completed jobs after its retention period, so the job table
covers only what it still holds (its oldest `agent.run` row is from Oct 26). The code path
(no enqueue in `eval/`) is the stronger argument.

**The real overlap was the reverse, and it is fixed.** Both runners (dev 4200, evaluation 4210)
consumed `agent.run`, `hijack.run` and `hijack.replay`, so a console or hijack job could be picked
up by the evaluation stack's runner. That happened on Oct 31 with scripted runs: the evaluation
runner, still on old code, failed some of them ("No pricing entry"). Live and demo model runs
could have been executed there too (same env files, so the same model and provider, but code that
a dev session can't change without restarting it). No evaluation result was affected.

**Change.** Live work now uses queues no evaluation runner listens on:

- `agent.run.live` (console and demo runs), `hijack.run.live`, `hijack.replay.live`; scripted runs
  stay on `agent.run.scripted`.
- The agent runner (`apps/agent-runner/src/worker.ts`) and web (`apps/web/lib/jobs.ts`) use only
  these. Nothing in the dev code consumes `agent.run`, `hijack.run` or `hijack.replay` any more, so
  those legacy names are consumed only by the running evaluation stack's old process. The
  evaluation stack was not restarted or modified.
- Jobs already waiting on the legacy queues at deploy time are not carried over (none were pending
  when checked).

## 2026-10-31 — Local assertion key rotated after it was printed

While looking at `.env.web` a masking command printed the PEM body of the local
`HUMAN_ASSERTION_PRIVATE_KEY` (web's Ed25519 key that signs 60-second human assertions) into a
development session's output. Nothing was committed. The local pair was rotated the same day
(`HUMAN_ASSERTION_PRIVATE_KEY` in `.env.web`, `HUMAN_ASSERTION_PUBLIC_KEY` in `.env.gateway`); the
rule-signing key, agent-token pepper and VAPID keys were left alone so signed rule cards stay
valid. Local development services must be restarted to pick up the new pair. Whether Render uses
the same key can't be seen from the repository: `.env.staging` holds no assertion key and the
deployment notes say Render has its own keys; check the Render value if it was ever pasted from
the local file.

## 2026-11-01 — Live agent moved from NVIDIA NIM to Groq (same model)

The live console, demo and hijack agent now runs `openai/gpt-oss-20b` on Groq
(`AGENT_PROVIDER=groq`, the new default), with the same `reasoning_effort` as before. Reason: on Nov 1
NIM's `gpt-oss-20b` timed out (a 16-token request took over 90 s) while the test evaluation was using
it, so all five hijack attempts hit the 60 s model timeout and fell back to a recorded replay; the
hijack-median target (under 30 s) could not be measured. Only the host changed. Hijack attempts are
a separate, unvetted dataset from the frozen evaluation, so this does not affect it, and the evaluation's
own routing (`evalProvider()`) is unchanged.

Groq's free allowance is per model. Read from rate-limit headers on Nov 1: `gpt-oss-20b` allows
8,000 tokens/min and 1,000 requests/day; the daily token limit (200,000 on Groq's published free
tier) is not in the headers. `HIJACK_DAILY_TOKENS` now defaults to 150,000 (web and agent-runner), so
hijack runs replay before the allowance is gone and console/demo keep some. `gpt-oss-120b`, which only
the evaluation uses, is never called by live code. After Nov 7 the live default moves to `gpt-oss-120b`.

### Same day: the evaluation runner was taking every other hijack job

The first five hijack attempts after the Groq switch alternated: done in 8–10 s, then replayed after
60 s, and so on. The 60 s ones timed out on NIM. Cause: the evaluation stack's agent runner (port
4210) was restarted on Nov 1 09:13 with the current code, so it also consumed the `.live` queues,
with the NIM default it had loaded. Every other hijack job went there. Direct Groq calls took under
1 s throughout. No evaluation result was affected (the evaluation does not enqueue jobs).

Fix, without touching the running evaluation processes: live work moved to `.app` queue names
(`agent.run.app`, `agent.run.app.scripted`, `hijack.run.app`, `hijack.replay.app`), which no running
process listens on, and the runner has a `CONSUME_JOBS` switch that `npm run eval:stack` now sets to
`false`, so a restarted evaluation runner serves no queue. Jobs still waiting on the `.live` names
are not carried over (none were pending).

## 2026-11-01 — One public environment instead of staging + production

Phase 30 planned separate `-prod` services and a Render database next to staging. Instead the four
existing Render services (`web`, `gateway`, `twokey-mcp`, `agent-runner`) and the existing Neon
database become production, deploying from a new `release` branch; `main` no
longer deploys the live site. Reason: one environment to configure, keep awake and demo before the
Nov 8 deploy freeze, and no second copy of every secret. Pre-release checks move to the local dev
stack: `scripts/release.sh` runs `npm run check` and `npm run smoke -- --env local` before
fast-forwarding `release`. `check:secrets` rejects any service other than the four, any branch
other than `release`, any plan other than `free` or `starter`, and `SHOW_STYLEGUIDE`.

Plans: `free` until Nov 8; `starter` from Nov 8 (deploy freeze) so nothing sleeps during judging;
back to `free` on Dec 16. Each switch is one commit to the four `plan:` lines. The gateway keeps
migrating at the start of its start command, since free plans can't run a `preDeployCommand`.

`twokey-mcp` is not published to npm; it ships as the v1.0.0 GitHub Release asset (phase 26).
Evaluation results reach production with `npm run eval:export` once the test split is done.
