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
