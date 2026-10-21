import Anthropic from '@anthropic-ai/sdk';
import type { CompilerClient } from './llm';

/** The Anthropic option for the rule compiler, behind the same interface as the default. */
export function createAnthropicClient(opts: { apiKey: string; model: string }): CompilerClient {
  const anthropic = new Anthropic({ apiKey: opts.apiKey, maxRetries: 0 });
  return {
    provider: 'anthropic',
    model: opts.model,
    pricePerMTok: { input: 3, output: 15 },
    async callTool(p) {
      const res = await anthropic.messages.create({
        model: p.model,
        system: p.system,
        messages: p.messages,
        tools: [
          {
            name: p.tool.name,
            description: p.tool.description,
            input_schema: { type: 'object', ...p.tool.schema },
          },
        ],
        tool_choice: { type: 'tool', name: p.tool.name },
        temperature: p.temperature,
        max_tokens: p.maxTokens,
      });
      const block = res.content.find((b) => b.type === 'tool_use');
      return {
        input: block?.type === 'tool_use' ? block.input : undefined,
        usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      };
    },
  };
}
