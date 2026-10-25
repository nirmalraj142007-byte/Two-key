import { createAnthropicAdapter } from './anthropic.js';
import { createOpenAICompatibleAdapter } from './openai-compatible.js';
import type { ModelAdapter } from './types.js';

export type { ModelAdapter, Msg } from './types.js';

export interface LlmConfig {
  ANTHROPIC_API_KEY?: string | undefined;
  AGENT_LLM_API_KEY?: string | undefined;
  AGENT_LLM_BASE_URL: string;
}

/** claude-* goes to Anthropic; every other model goes to the OpenAI-compatible endpoint. */
export function adapterFor(model: string, cfg: LlmConfig): ModelAdapter {
  if (model.startsWith('claude-')) return createAnthropicAdapter(model, cfg.ANTHROPIC_API_KEY);
  return createOpenAICompatibleAdapter(model, {
    apiKey: cfg.AGENT_LLM_API_KEY,
    baseURL: cfg.AGENT_LLM_BASE_URL,
  });
}
