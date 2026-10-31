# Decisions

## 2026-10-31 — LLM cost and spend caps (W22)

Confirmed by the team on 2026-10-31.

- **All model use is on free tiers.**
  - Groq free tier: `openai/gpt-oss-120b` (test-split evaluation) and `qwen/qwen3.8-27b` (rule
    compiler until the test split is done).
  - NVIDIA NIM free tier: `openai/gpt-oss-20b` (live and demo agent, the hijack box, evaluation and
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
