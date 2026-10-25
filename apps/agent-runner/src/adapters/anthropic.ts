import Anthropic from '@anthropic-ai/sdk';
import { AppError, ErrorCode } from '@twokey/core';
import { classifyError, REQUEST_TIMEOUT_MS, withRetry } from './retry.js';
import type { ModelAdapter, Msg } from './types.js';

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };
type AnthropicMsg = { role: 'user' | 'assistant'; content: string | Block[] };

export function toAnthropicMessages(messages: Msg[]): AnthropicMsg[] {
  const out: AnthropicMsg[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text ?? '' });
    } else if (m.role === 'assistant') {
      const content: Block[] = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
      }
      if (content.length > 0) out.push({ role: 'assistant', content });
    } else {
      // Results for one assistant turn must share a single user message.
      const block: Block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId ?? '',
        content: m.toolResult ?? '',
      };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

export function createAnthropicAdapter(model: string, apiKey: string | undefined): ModelAdapter {
  if (!apiKey) {
    throw new AppError(ErrorCode.CONFIG_INVALID, `ANTHROPIC_API_KEY is required for ${model}`);
  }
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS });
  return {
    id: model,
    async step(i) {
      const res = await withRetry(
        () =>
          client.messages.create({
            model,
            system: i.system,
            max_tokens: i.maxOutputTokens,
            temperature: i.temperature,
            messages: toAnthropicMessages(i.messages) as Anthropic.MessageParam[],
            tools: i.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
            })),
          }),
        classifyError,
      );
      const text = res.content
        .flatMap((b) => (b.type === 'text' ? [b.text] : []))
        .join('\n')
        .trim();
      const toolCalls = res.content.flatMap((b) =>
        b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : [],
      );
      return {
        text,
        toolCalls,
        stop:
          res.stop_reason === 'tool_use'
            ? ('tool' as const)
            : res.stop_reason === 'max_tokens'
              ? ('max_tokens' as const)
              : ('end' as const),
        usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      };
    },
  };
}
