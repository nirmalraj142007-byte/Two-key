import { createAnthropicAdapter } from './anthropic.js';
import { createOpenAICompatibleAdapter } from './openai-compatible.js';
import { NIM_EVAL_TIMEOUT_MS } from './retry.js';
import { createScriptedAdapter } from './scripted.js';
import type { ModelAdapter } from './types.js';

export type { ModelAdapter, Msg } from './types.js';

export interface LlmConfig {
  ANTHROPIC_API_KEY?: string | undefined;
  AGENT_LLM_API_KEY?: string | undefined;
  AGENT_LLM_BASE_URL: string;
  /** Provider for live, demo and hijack sessions; groq when unset. */
  AGENT_PROVIDER?: 'groq' | 'nim' | undefined;
  /** NVIDIA NIM: eval sessions, and live ones when AGENT_PROVIDER is nim. */
  EVAL_LLM_API_KEY?: string | undefined;
  EVAL_LLM_BASE_URL?: string | undefined;
  NODE_ENV?: 'development' | 'test' | 'production' | undefined;
  /** 'true' lets scripted:<name> models run when NODE_ENV is production. */
  ALLOW_SCRIPTED?: string | undefined;
  /** OpenAI-compatible models only: sees each response's headers. */
  onHeaders?: ((headers: Headers) => void) | undefined;
}

export interface AdapterOptions {
  /** 'eval' routes OpenAI-compatible models per evalProvider(); everything else uses AGENT_LLM_*. */
  purpose?: 'agent' | 'eval';
  /** Default 'medium'; null leaves reasoning_effort out. */
  reasoningEffort?: 'low' | 'medium' | null;
}

/** Eval models served by Groq's free tier (AGENT_LLM_*); every other eval model goes to NIM. */
export const EVAL_GROQ_MODELS: ReadonlySet<string> = new Set(['openai/gpt-oss-120b']);

/** Eval models that accept reasoning_effort; every other eval model is sent none. */
export const EVAL_REASONING_MODELS: ReadonlySet<string> = new Set([
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
]);

export function evalProvider(model: string): 'groq' | 'nim' {
  return EVAL_GROQ_MODELS.has(model) ? 'groq' : 'nim';
}

/**
 * scripted:<name> replays a JSON script; claude-* goes to Anthropic; every other model goes to an
 * OpenAI-compatible endpoint.
 */
export function adapterFor(model: string, cfg: LlmConfig, o: AdapterOptions = {}): ModelAdapter {
  if (model.startsWith('scripted:')) return createScriptedAdapter(model, cfg);
  if (model.startsWith('claude-')) return createAnthropicAdapter(model, cfg.ANTHROPIC_API_KEY);
  if (o.purpose === 'eval') {
    const reasoningEffort =
      o.reasoningEffort !== undefined
        ? o.reasoningEffort
        : EVAL_REASONING_MODELS.has(model)
          ? 'low'
          : null;
    if (evalProvider(model) === 'groq') {
      return createOpenAICompatibleAdapter(model, {
        apiKey: cfg.AGENT_LLM_API_KEY,
        baseURL: cfg.AGENT_LLM_BASE_URL,
        onHeaders: cfg.onHeaders,
        reasoningEffort,
      });
    }
    return createOpenAICompatibleAdapter(model, {
      apiKey: cfg.EVAL_LLM_API_KEY,
      baseURL: cfg.EVAL_LLM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
      onHeaders: cfg.onHeaders,
      reasoningEffort,
      timeoutMs: NIM_EVAL_TIMEOUT_MS,
      keyName: 'EVAL_LLM_API_KEY',
    });
  }
  if (cfg.AGENT_PROVIDER === 'nim') {
    return createOpenAICompatibleAdapter(model, {
      apiKey: cfg.EVAL_LLM_API_KEY,
      baseURL: cfg.EVAL_LLM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
      onHeaders: cfg.onHeaders,
      reasoningEffort: o.reasoningEffort,
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
