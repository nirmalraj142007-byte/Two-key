import { AppError, ErrorCode } from '@twokey/core';
import OpenAI from 'openai';
import { classifyError, REQUEST_TIMEOUT_MS, withRetry } from './retry.js';
import type { ModelAdapter, Msg } from './types.js';

type ChatMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export function toChatMessages(system: string, messages: Msg[]): ChatMsg[] {
  const out: ChatMsg[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text ?? '' });
    } else if (m.role === 'assistant') {
      const calls = m.toolCalls ?? [];
      out.push({
        role: 'assistant',
        content: m.text ?? null,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
    } else {
      out.push({ role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.toolResult ?? '' });
    }
  }
  return out;
}

/** Groq uses message.reasoning; some compatible servers use reasoning_content. */
function reasoningOf(message: object): string {
  const m = message as { reasoning?: unknown; reasoning_content?: unknown };
  const r = m.reasoning ?? m.reasoning_content;
  return typeof r === 'string' ? r.trim() : '';
}

function parseArguments(raw: string): unknown {
  try {
    return raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    return {}; // the tool then rejects it and the model sees the error
  }
}

/** Any OpenAI-compatible chat endpoint with function tools; Groq by default. */
export function createOpenAICompatibleAdapter(
  model: string,
  opts: { apiKey: string | undefined; baseURL: string },
): ModelAdapter {
  if (!opts.apiKey) {
    throw new AppError(ErrorCode.CONFIG_INVALID, `AGENT_LLM_API_KEY is required for ${model}`);
  }
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
  });
  return {
    id: model,
    async step(i) {
      const res = await withRetry(
        () =>
          client.chat.completions.create({
            model,
            messages: toChatMessages(i.system, i.messages),
            max_tokens: i.maxOutputTokens,
            temperature: i.temperature,
            // Groq returns message.reasoning for gpt-oss by default and for qwen only above "default".
            reasoning_effort: 'medium',
            tools: i.tools.map((t) => ({
              type: 'function' as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.inputSchema as Record<string, unknown>,
              },
            })),
          }),
        classifyError,
      );
      const choice = res.choices[0];
      if (!choice) throw new AppError(ErrorCode.UPSTREAM_LLM, 'Model call failed: no choices');
      const toolCalls = (choice.message.tool_calls ?? []).flatMap((c) =>
        c.type === 'function'
          ? [{ id: c.id, name: c.function.name, input: parseArguments(c.function.arguments) }]
          : [],
      );
      const reasoning = reasoningOf(choice.message);
      return {
        text: (choice.message.content ?? '').trim(),
        ...(reasoning ? { reasoning } : {}),
        toolCalls,
        stop:
          toolCalls.length > 0
            ? ('tool' as const)
            : choice.finish_reason === 'length'
              ? ('max_tokens' as const)
              : ('end' as const),
        usage: {
          inputTokens: res.usage?.prompt_tokens ?? 0,
          outputTokens: res.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}
