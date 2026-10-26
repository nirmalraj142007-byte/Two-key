import { createAnthropicAdapter } from './anthropic.js';
import { createOpenAICompatibleAdapter } from './openai-compatible.js';
import type { ModelAdapter } from './types.js';

export type { ModelAdapter, Msg } from './types.js';

export interface LlmConfig {
  ANTHROPIC_API_KEY?: string | undefined;
  AGENT_LLM_API_KEY?: string | undefined;
  AGENT_LLM_BASE_URL: string;
  /** Eval sessions only (NVIDIA NIM). */
  EVAL_LLM_API_KEY?: string | undefined;
  EVAL_LLM_BASE_URL?: string | undefined;
  /** OpenAI-compatible models only: sees each response's headers. */
  onHeaders?: ((headers: Headers) => void) | undefined;
}

export interface AdapterOptions {
  /** 'eval' routes OpenAI-compatible models to EVAL_LLM_*; everything else uses AGENT_LLM_*. */
  purpose?: 'agent' | 'eval';
  /** Default 'medium'; null leaves reasoning_effort out. */
  reasoningEffort?: 'low' | 'medium' | null;
}

/** Eval models that accept reasoning_effort; every other eval model is sent none. */
export const EVAL_REASONING_MODELS: ReadonlySet<string> = new Set(['openai/gpt-oss-20b']);

/** claude-* goes to Anthropic; every other model goes to an OpenAI-compatible endpoint. */
export function adapterFor(model: string, cfg: LlmConfig, o: AdapterOptions = {}): ModelAdapter {
  if (model.startsWith('claude-')) return createAnthropicAdapter(model, cfg.ANTHROPIC_API_KEY);
  if (o.purpose === 'eval') {
    return createOpenAICompatibleAdapter(model, {
      apiKey: cfg.EVAL_LLM_API_KEY,
      baseURL: cfg.EVAL_LLM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
      onHeaders: cfg.onHeaders,
      reasoningEffort:
        o.reasoningEffort !== undefined
          ? o.reasoningEffort
          : EVAL_REASONING_MODELS.has(model)
            ? 'low'
            : null,
      keyName: 'EVAL_LLM_API_KEY',
    });
  }
  return createOpenAICompatibleAdapter(model, {
    apiKey: cfg.AGENT_LLM_API_KEY,
    baseURL: cfg.AGENT_LLM_BASE_URL,
    onHeaders: cfg.onHeaders,
    reasoningEffort: o.reasoningEffort,
  });
}
