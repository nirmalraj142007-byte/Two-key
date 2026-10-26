import { AppError, ErrorCode } from '@twokey/core';

export interface ModelPrice {
  /** USD per million tokens. */
  inputPerMTok: number;
  outputPerMTok: number;
  source: string;
  asOf: string;
}

const CLAUDE_PRICING = 'https://platform.claude.com/docs/en/about-claude/pricing';
const GROQ_FREE = 'Groq free tier, 2026-10-25';
const AS_OF = '2026-10-25';
const NIM_FREE = 'NVIDIA NIM free tier, 2026-10-26';
const NIM_AS_OF = '2026-10-26';

/** Looked up on the provider's page, never guessed. Haiku is the up-to-100k-token-prompt tier. */
export const PRICING: Record<string, ModelPrice> = {
  'claude-sonnet-5-5': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    source: CLAUDE_PRICING,
    asOf: AS_OF,
  },
  'claude-haiku-5-5': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    source: CLAUDE_PRICING,
    asOf: AS_OF,
  },
  'openai/gpt-oss-120b': { inputPerMTok: 0, outputPerMTok: 0, source: GROQ_FREE, asOf: AS_OF },
  'qwen/qwen3.8-27b': { inputPerMTok: 0, outputPerMTok: 0, source: GROQ_FREE, asOf: AS_OF },
  // Evaluation models on NVIDIA NIM (gpt-oss-120b above is evaluated on Groq's free tier).
  'openai/gpt-oss-20b': { inputPerMTok: 0, outputPerMTok: 0, source: NIM_FREE, asOf: NIM_AS_OF },
  'nvidia/nemotron-3.5-bolt-e4b': {
    inputPerMTok: 0,
    outputPerMTok: 0,
    source: NIM_FREE,
    asOf: NIM_AS_OF,
  },
};

export function priceFor(model: string): ModelPrice {
  const price = PRICING[model];
  if (!price) {
    throw new AppError(ErrorCode.CONFIG_INVALID, `No pricing entry for model ${model}`);
  }
  return price;
}

/** Throws at startup naming the first model without a price. */
export function assertPriced(models: readonly string[]): void {
  for (const m of models) priceFor(m);
}

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000;
}

export function parseModelList(csv: string): string[] {
  return csv
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
}
