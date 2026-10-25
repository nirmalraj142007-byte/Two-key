import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AppError, ErrorCode } from '@twokey/core';
import type { BudgetScope } from '@twokey/db';
import type { ModelAdapter, Msg } from './adapters/types.js';
import { costUsd, priceFor } from './pricing.js';
import type { RunStore } from './store.js';
import { GUARDRAIL_PROMPT } from './system-prompt.js';

export type Mode = 'live' | 'demo' | 'hijack' | 'eval';

export interface TranscriptEntry {
  turn: number;
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
  toolCalls?: { id: string; name: string; input: unknown }[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  at: string;
}

/** The slice of the MCP client the loop uses. */
export type McpLike = Pick<Client, 'listTools' | 'callTool' | 'close'>;

export interface RunDeps {
  store: RunStore;
  adapter: ModelAdapter;
  /** Opens an MCP connection that sends `token` as the bearer. */
  connect: (token: string) => Promise<McpLike>;
  caps: Record<BudgetScope, number>;
  now?: () => Date;
  /** Receives the cause of a failed run (never the token). */
  onError?: (err: unknown) => void;
}

export interface RunInput {
  sessionId: string;
  userId: string;
  token: string;
  userMessage: string;
  model: string;
  mode: Mode;
  maxTurns?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  temperature?: number;
}

export interface RunResult {
  status: 'ended' | 'failed';
  reason?: 'budget' | 'max_turns' | 'error';
  /** AppError code when reason is 'error' or 'budget'. */
  code?: string;
  transcript: TranscriptEntry[];
  proposals: string[];
}

const NOTIFY_TEXT_MAX = 2000;
const NOTIFY_BYTES_MAX = 7000; // pg_notify payloads must stay under 8000 bytes
const EXCERPT_MAX = 500;
const TOOL_RESULT_MAX = 8000;

export function mcpConnector(mcpUrl: string): RunDeps['connect'] {
  const url = new URL(mcpUrl);
  // DEPLOY.md gives the service root; the Streamable HTTP endpoint lives at /mcp.
  if (url.pathname === '/') url.pathname = '/mcp';
  return async (token) => {
    const client = new Client({ name: 'twokey-agent-runner', version: '0.1.0' });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };
}

function scopeOf(mode: Mode): BudgetScope {
  return mode === 'hijack' ? 'hijack' : mode === 'eval' ? 'eval' : 'live';
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((c) => {
      const part = c as { type?: string; text?: string };
      return part.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
    })
    .join('\n');
}

function proposalIdOf(result: unknown): string | undefined {
  const id = (result as { structuredContent?: { proposalId?: unknown } }).structuredContent
    ?.proposalId;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function estimateInputTokens(system: string, messages: Msg[], tools: object[]): number {
  return Math.ceil(
    (system.length + JSON.stringify(messages).length + JSON.stringify(tools).length) / 4,
  );
}

export async function runSession(deps: RunDeps, i: RunInput): Promise<RunResult> {
  const maxTurns = i.maxTurns ?? 8;
  const maxOutputTokens = i.maxOutputTokens ?? 1024;
  const maxTotalTokens = i.maxTotalTokens ?? 40_000;
  const temperature = i.temperature ?? 0;
  const now = deps.now ?? (() => new Date());
  const scope = scopeOf(i.mode);

  const transcript: TranscriptEntry[] = [];
  const proposalIds: string[] = [];
  const messages: Msg[] = [{ role: 'user', text: i.userMessage }];
  let totalTokens = 0;
  let mcp: McpLike | undefined;
  let result: Pick<RunResult, 'status' | 'reason' | 'code'> = { status: 'ended' };

  // The bearer token only travels in the MCP request header; scrub it from anything stored.
  const scrub = (s: string): string => (i.token ? s.split(i.token).join('[Redacted]') : s);
  const add = (entry: Omit<TranscriptEntry, 'at'>): TranscriptEntry => {
    const full: TranscriptEntry = { ...entry, text: scrub(entry.text), at: now().toISOString() };
    transcript.push(full);
    return full;
  };
  const publish = async (entry: TranscriptEntry): Promise<void> => {
    let shown = { ...entry, text: clip(entry.text, NOTIFY_TEXT_MAX) };
    let payload = { type: 'agent.step', userId: i.userId, sessionId: i.sessionId, entry: shown };
    if (JSON.stringify(payload).length > NOTIFY_BYTES_MAX) {
      const { toolCalls: _drop, ...rest } = shown;
      shown = { ...rest, text: clip(entry.text, 500) };
      payload = { ...payload, entry: shown };
    }
    await deps.store.notify(payload);
  };

  add({ turn: 0, role: 'user', text: i.userMessage });

  try {
    priceFor(i.model);
    mcp = await deps.connect(i.token);
    const { tools: listed } = await mcp.listTools();
    const tools = listed.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as object,
    }));

    let finished = false;
    for (let turn = 1; turn <= maxTurns && !finished; turn++) {
      const estimate = costUsd(
        i.model,
        estimateInputTokens(GUARDRAIL_PROMPT, messages, tools),
        maxOutputTokens,
      );
      await deps.store.spend(scope, estimate, deps.caps[scope]);

      const step = await deps.adapter.step({
        system: GUARDRAIL_PROMPT,
        messages,
        tools,
        maxOutputTokens,
        temperature,
      });
      totalTokens += step.usage.inputTokens + step.usage.outputTokens;

      const assistant = add({
        turn,
        role: 'assistant',
        text: step.text,
        ...(step.toolCalls.length > 0 ? { toolCalls: step.toolCalls } : {}),
        usage: {
          ...step.usage,
          costUsd: costUsd(i.model, step.usage.inputTokens, step.usage.outputTokens),
        },
      });
      await publish(assistant);
      messages.push({
        role: 'assistant',
        text: step.text,
        ...(step.toolCalls.length > 0 ? { toolCalls: step.toolCalls } : {}),
      });

      if (step.toolCalls.length === 0) {
        finished = true;
        break;
      }

      for (const call of step.toolCalls) {
        let text: string;
        let isError = false;
        let proposalId: string | undefined;
        try {
          const res = await mcp.callTool({
            name: call.name,
            arguments: (call.input ?? {}) as Record<string, unknown>,
          });
          text = textOf(res);
          isError = res.isError === true;
          if (call.name === 'propose_purchase' && !isError) proposalId = proposalIdOf(res);
        } catch (err) {
          // A failed tool call is a result the model may recover from.
          text = err instanceof Error ? err.message : 'Tool call failed';
          isError = true;
        }
        const toolEntry = add({
          turn,
          role: 'tool',
          text: clip(text, TOOL_RESULT_MAX),
          toolCallId: call.id,
          toolName: call.name,
          ...(isError ? { isError } : {}),
        });
        messages.push({ role: 'tool', toolCallId: call.id, toolResult: toolEntry.text });
        await publish(toolEntry);

        if (proposalId) {
          proposalIds.push(proposalId);
          const excerpt = clip(scrub(step.text), EXCERPT_MAX);
          if (excerpt !== '') await deps.store.setReasoning(i.sessionId, proposalId, excerpt);
        }
      }

      if (totalTokens > maxTotalTokens) {
        result = { status: 'failed', reason: 'budget' };
        finished = true;
      }
    }
    if (!finished) result = { status: 'failed', reason: 'max_turns' };
  } catch (err) {
    deps.onError?.(err);
    const code = err instanceof AppError ? err.code : ErrorCode.INTERNAL;
    const message = err instanceof AppError ? err.message : 'Internal error';
    result =
      code === ErrorCode.BUDGET_EXCEEDED
        ? { status: 'failed', reason: 'budget', code }
        : { status: 'failed', reason: 'error', code };
    add({ turn: transcript.length, role: 'error', text: `${code}: ${message}`, isError: true });
  } finally {
    await mcp?.close().catch(() => undefined);
  }

  if (result.status === 'failed' && result.reason !== 'error' && !result.code) {
    add({
      turn: transcript.length,
      role: 'error',
      text: `failed: ${result.reason}`,
      isError: true,
    });
  }
  await deps.store.finish({ sessionId: i.sessionId, status: result.status, transcript });
  return { ...result, transcript, proposals: proposalIds };
}
