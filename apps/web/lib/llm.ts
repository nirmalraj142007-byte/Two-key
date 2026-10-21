import { AppError, ErrorCode } from '@twokey/core';
import OpenAI from 'openai';
import { webEnv } from './env';

export interface ToolCallParams {
  model: string;
  system: string;
  messages: { role: 'user'; content: string }[];
  tool: { name: string; description: string; schema: Record<string, unknown> };
  temperature: 0;
  maxTokens: number;
}

export interface ToolCallResult {
  /** The model's tool arguments, unvalidated. */
  input: unknown;
  usage: { inputTokens: number; outputTokens: number };
}

/** Provider-neutral: one forced tool call in, its raw arguments out. */
export interface CompilerClient {
  readonly provider: 'openai-compatible' | 'anthropic';
  readonly model: string;
  /** USD per million tokens; 0 for free-tier endpoints. */
  readonly pricePerMTok: { input: number; output: number };
  callTool(params: ToolCallParams): Promise<ToolCallResult>;
}

const RETRY_DELAYS_MS = [1000, 4000];

interface HttpLikeError {
  status?: number;
  headers?: Headers | Record<string, string | undefined>;
}

function statusOf(err: unknown): number | undefined {
  return typeof err === 'object' && err !== null ? (err as HttpLikeError).status : undefined;
}

function retryAfterMs(err: unknown): number | undefined {
  const headers =
    typeof err === 'object' && err !== null ? (err as HttpLikeError).headers : undefined;
  const raw = headers instanceof Headers ? headers.get('retry-after') : headers?.['retry-after'];
  const seconds = raw === undefined || raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 30) * 1000 : undefined;
}

function isRetryable(status: number | undefined): boolean {
  return status === 429 || status === 529 || (status !== undefined && status >= 500);
}

/** Retries 429, 529 and 5xx twice (retry-after, else 1 s then 4 s plus jitter). */
export async function withRetry<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      const status = statusOf(err);
      const delay = RETRY_DELAYS_MS[attempt];
      if (!isRetryable(status) || delay === undefined) {
        throw new AppError(ErrorCode.UPSTREAM_LLM, 'The AI service is unavailable', {
          retryable: true,
          details: { status },
          cause: err,
        });
      }
      await sleep((retryAfterMs(err) ?? delay) + Math.floor(Math.random() * 250));
    }
  }
}

export function createOpenAICompatibleClient(opts: {
  apiKey: string;
  baseURL: string;
  model: string;
}): CompilerClient {
  // Groq's free tier costs nothing; any other endpoint is priced conservatively.
  const free = new URL(opts.baseURL).hostname.endsWith('groq.com');
  const openai = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 0 });
  return {
    provider: 'openai-compatible',
    model: opts.model,
    pricePerMTok: free ? { input: 0, output: 0 } : { input: 3, output: 15 },
    async callTool(p) {
      const res = await openai.chat.completions.create({
        model: p.model,
        messages: [{ role: 'system', content: p.system }, ...p.messages],
        tools: [
          {
            type: 'function',
            function: {
              name: p.tool.name,
              description: p.tool.description,
              parameters: p.tool.schema,
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: p.tool.name } },
        temperature: p.temperature,
        max_tokens: p.maxTokens,
      });
      const call = res.choices[0]?.message.tool_calls?.find((c) => c.type === 'function');
      let input: unknown;
      try {
        input = call?.type === 'function' ? JSON.parse(call.function.arguments) : undefined;
      } catch {
        input = undefined;
      }
      return {
        input,
        usage: {
          inputTokens: res.usage?.prompt_tokens ?? 0,
          outputTokens: res.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}

/** The compiler's client, chosen by COMPILER_PROVIDER. */
export async function createCompilerClient(): Promise<CompilerClient> {
  const env = webEnv();
  if (env.COMPILER_PROVIDER === 'anthropic') {
    const { createAnthropicClient } = await import('./anthropic');
    if (!env.ANTHROPIC_API_KEY) {
      throw new AppError(ErrorCode.CONFIG_INVALID, 'ANTHROPIC_API_KEY is not set');
    }
    return createAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY, model: env.COMPILER_MODEL });
  }
  if (!env.COMPILER_API_KEY) {
    throw new AppError(ErrorCode.CONFIG_INVALID, 'COMPILER_API_KEY is not set');
  }
  return createOpenAICompatibleClient({
    apiKey: env.COMPILER_API_KEY,
    baseURL: env.COMPILER_BASE_URL,
    model: env.COMPILER_MODEL,
  });
}
