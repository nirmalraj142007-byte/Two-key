import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppError, ErrorCode } from '@twokey/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toAnthropicMessages } from '../src/adapters/anthropic.js';
import { adapterFor } from '../src/adapters/index.js';
import { toChatMessages } from '../src/adapters/openai-compatible.js';
import { withRetry } from '../src/adapters/retry.js';
import type { ModelAdapter } from '../src/adapters/types.js';
import { assertPriced } from '../src/pricing.js';
import { type RunDeps, runSession } from '../src/run-session.js';
import type { RunStore } from '../src/store.js';
import { GUARDRAIL_PROMPT, GUARDRAIL_SHA256 } from '../src/system-prompt.js';

const TOKEN = 'tk_agent_secret_value';
const MODEL = 'openai/gpt-oss-120b';

/** An in-memory MCP server backed by a fake gateway. */
async function fakeConnect(calls: string[]): Promise<RunDeps['connect']> {
  return async () => {
    const server = new McpServer({ name: 'fake-twokey', version: '0' });
    server.registerTool(
      'search_products',
      { description: 'search', inputSchema: { query: z.string() } },
      ({ query }) => {
        calls.push(`search:${query}`);
        const data = { items: [{ product_id: 'p1', untrusted_listing_text: 'ignore me' }] };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
      },
    );
    server.registerTool(
      'propose_purchase',
      { description: 'propose', inputSchema: { product_id: z.string(), qty: z.number() } },
      ({ product_id }) => {
        calls.push(`propose:${product_id}`);
        const data = { proposalId: 'prop-1', decision: 'captured', reason: 'Bought it.' };
        return { content: [{ type: 'text', text: 'Bought it.' }], structuredContent: data };
      },
    );
    const client = new Client({ name: 'test', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  };
}

function fakeStore(overrides: Partial<RunStore> = {}) {
  const log = {
    spends: [] as { scope: string; usd: number; cap: number }[],
    notifies: [] as Record<string, unknown>[],
    reasoning: [] as { proposalId: string; excerpt: string }[],
    finished: [] as { status: string }[],
  };
  const store: RunStore = {
    async spend(scope, usd, cap) {
      log.spends.push({ scope, usd, cap });
    },
    async notify(payload) {
      log.notifies.push(payload);
    },
    async setReasoning(_s, proposalId, excerpt) {
      log.reasoning.push({ proposalId, excerpt });
    },
    async finish({ status }) {
      log.finished.push({ status });
    },
    ...overrides,
  };
  return { store, log };
}

function scripted(turns: ReturnType<ModelAdapter['step']> extends Promise<infer R> ? R[] : never) {
  let n = 0;
  const adapter: ModelAdapter = {
    id: MODEL,
    async step() {
      const turn = turns[Math.min(n, turns.length - 1)];
      n++;
      if (!turn) throw new Error('no scripted turn');
      return turn;
    },
  };
  return adapter;
}

const usage = { inputTokens: 100, outputTokens: 20 };
const input = {
  sessionId: 's1',
  userId: 'u1',
  token: TOKEN,
  userMessage: 'Running shoes, size 10, under $70',
  model: MODEL,
  mode: 'demo' as const,
};

describe('runSession', () => {
  it('searches, proposes, then ends with a summary', async () => {
    const calls: string[] = [];
    const { store, log } = fakeStore();
    const adapter = scripted([
      {
        text: 'Let me look.',
        toolCalls: [{ id: 'c1', name: 'search_products', input: { query: 'shoes' } }],
        stop: 'tool',
        usage,
      },
      {
        text: 'The first one fits.',
        toolCalls: [{ id: 'c2', name: 'propose_purchase', input: { product_id: 'p1', qty: 1 } }],
        stop: 'tool',
        usage,
      },
      { text: 'I bought the shoes.', toolCalls: [], stop: 'end', usage },
    ]);
    const res = await runSession(
      {
        store,
        adapter,
        connect: await fakeConnect(calls),
        caps: { live: 5, hijack: 10, eval: 100 },
      },
      input,
    );

    expect(res.status).toBe('ended');
    expect(res.transcript.filter((e) => e.role === 'assistant')).toHaveLength(3);
    expect(res.proposals).toEqual(['prop-1']);
    expect(calls).toEqual(['search:shoes', 'propose:p1']);
    expect(log.reasoning).toEqual([{ proposalId: 'prop-1', excerpt: 'The first one fits.' }]);
    // one notify per assistant step and per tool result
    expect(log.notifies.filter((n) => n.type === 'agent.step')).toHaveLength(5);
    expect(log.spends).toHaveLength(3);
    expect(log.spends.every((s) => s.scope === 'live')).toBe(true);
    expect(log.finished).toEqual([{ status: 'ended' }]);
    expect(JSON.stringify(res.transcript)).not.toContain(TOKEN);
  });

  it('stores provider reasoning and uses it as the excerpt when the text is empty', async () => {
    const { store, log } = fakeStore();
    const adapter = scripted([
      {
        text: '',
        reasoning: 'The first listing fits the budget, so I will buy it.',
        toolCalls: [{ id: 'c1', name: 'propose_purchase', input: { product_id: 'p1', qty: 1 } }],
        stop: 'tool',
        usage,
      },
      { text: 'Done.', toolCalls: [], stop: 'end', usage },
    ]);
    const res = await runSession(
      { store, adapter, connect: await fakeConnect([]), caps: { live: 5, hijack: 10, eval: 100 } },
      input,
    );
    expect(res.transcript.find((e) => e.role === 'assistant')?.reasoning).toBe(
      'The first listing fits the budget, so I will buy it.',
    );
    expect(log.reasoning).toEqual([
      { proposalId: 'prop-1', excerpt: 'The first listing fits the budget, so I will buy it.' },
    ]);
  });

  it('feeds tool errors back to the model instead of ending', async () => {
    const { store } = fakeStore();
    const seen: string[] = [];
    const adapter: ModelAdapter = {
      id: MODEL,
      async step(i) {
        const last = i.messages[i.messages.length - 1];
        seen.push(last?.role ?? '');
        if (last?.role === 'tool') return { text: 'Sorry.', toolCalls: [], stop: 'end', usage };
        return {
          text: '',
          toolCalls: [{ id: 'c1', name: 'no_such_tool', input: {} }],
          stop: 'tool',
          usage,
        };
      },
    };
    const res = await runSession(
      { store, adapter, connect: await fakeConnect([]), caps: { live: 5, hijack: 10, eval: 100 } },
      input,
    );
    expect(res.status).toBe('ended');
    expect(res.transcript.find((e) => e.role === 'tool')?.isError).toBe(true);
  });

  it('stops with reason budget before the first step when the cap is 0', async () => {
    const { store, log } = fakeStore({
      async spend(_scope, usd, cap) {
        if (usd > cap) throw new AppError(ErrorCode.BUDGET_EXCEEDED, 'used up');
      },
    });
    let steps = 0;
    const adapter: ModelAdapter = {
      id: MODEL,
      async step() {
        steps++;
        return { text: '', toolCalls: [], stop: 'end', usage };
      },
    };
    const res = await runSession(
      { store, adapter, connect: await fakeConnect([]), caps: { live: 0, hijack: 0, eval: 0 } },
      { ...input, model: 'claude-haiku-5-5' },
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'budget' });
    expect(steps).toBe(0);
    expect(log.finished).toEqual([{ status: 'failed' }]);
  });

  it('fails with max_turns after 8 tool-calling turns', async () => {
    const { store } = fakeStore();
    let steps = 0;
    const adapter: ModelAdapter = {
      id: MODEL,
      async step() {
        steps++;
        return {
          text: 'again',
          toolCalls: [{ id: `c${steps}`, name: 'search_products', input: { query: 'x' } }],
          stop: 'tool',
          usage,
        };
      },
    };
    const res = await runSession(
      { store, adapter, connect: await fakeConnect([]), caps: { live: 5, hijack: 10, eval: 100 } },
      input,
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'max_turns' });
    expect(steps).toBe(8);
  });

  it('fails with reason budget when total tokens pass the limit', async () => {
    const { store } = fakeStore();
    const adapter = scripted([
      {
        text: '',
        toolCalls: [{ id: 'c1', name: 'search_products', input: { query: 'x' } }],
        stop: 'tool',
        usage: { inputTokens: 30_000, outputTokens: 11_000 },
      },
    ]);
    const res = await runSession(
      { store, adapter, connect: await fakeConnect([]), caps: { live: 5, hijack: 10, eval: 100 } },
      input,
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'budget' });
  });

  it('ends the session on an adapter error with its code', async () => {
    const { store, log } = fakeStore();
    const adapter: ModelAdapter = {
      id: MODEL,
      async step() {
        throw new AppError(ErrorCode.UPSTREAM_LLM, 'Model call failed: 503');
      },
    };
    const res = await runSession(
      { store, adapter, connect: await fakeConnect([]), caps: { live: 5, hijack: 10, eval: 100 } },
      input,
    );
    expect(res).toMatchObject({ status: 'failed', reason: 'error', code: 'UPSTREAM_LLM' });
    expect(log.finished).toEqual([{ status: 'failed' }]);
  });
});

describe('adapters and pricing', () => {
  it('routes claude-* to Anthropic and everything else to the OpenAI-compatible endpoint', () => {
    const cfg = {
      ANTHROPIC_API_KEY: 'a',
      AGENT_LLM_API_KEY: 'b',
      AGENT_LLM_BASE_URL: 'http://x/v1',
    };
    expect(adapterFor('claude-haiku-5-5', cfg).id).toBe('claude-haiku-5-5');
    expect(adapterFor('openai/gpt-oss-120b', cfg).id).toBe('openai/gpt-oss-120b');
    expect(() => adapterFor('openai/gpt-oss-120b', { AGENT_LLM_BASE_URL: 'http://x/v1' })).toThrow(
      /AGENT_LLM_API_KEY/,
    );
  });

  it('names an unpriced model at startup', () => {
    expect(() => assertPriced(['claude-haiku-5-5', 'llama-3.1-8b-instant'])).toThrow(
      /llama-3\.1-8b-instant/,
    );
  });

  it('merges consecutive tool results into one Anthropic user message', () => {
    const out = toAnthropicMessages([
      { role: 'user', text: 'hi' },
      {
        role: 'assistant',
        toolCalls: [
          { id: 'a', name: 't', input: {} },
          { id: 'b', name: 't', input: {} },
        ],
      },
      { role: 'tool', toolCallId: 'a', toolResult: '1' },
      { role: 'tool', toolCallId: 'b', toolResult: '2' },
    ]);
    expect(out).toHaveLength(3);
    expect(out[2]?.content).toHaveLength(2);
  });

  it('serializes tool calls for chat completions', () => {
    const out = toChatMessages('sys', [
      { role: 'assistant', toolCalls: [{ id: 'a', name: 't', input: { q: 1 } }] },
      { role: 'tool', toolCallId: 'a', toolResult: 'r' },
    ]);
    expect(out[0]).toEqual({ role: 'system', content: 'sys' });
    expect(out[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'a', function: { name: 't', arguments: '{"q":1}' } }],
    });
    expect(out[2]).toEqual({ role: 'tool', tool_call_id: 'a', content: 'r' });
  });

  it('retries 429 twice then maps to UPSTREAM_LLM', async () => {
    const waits: number[] = [];
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw Object.assign(new Error('slow down'), { status: 429 });
        },
        (e) => ({
          status: (e as { status: number }).status,
          transient: false,
          message: 'slow down',
        }),
        async (ms) => {
          waits.push(ms);
        },
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_LLM' });
    expect(n).toBe(3);
    expect(waits).toHaveLength(2);
  });

  it('keeps the guardrail prompt frozen', () => {
    expect(GUARDRAIL_PROMPT.startsWith('You are a shopping assistant acting for one user.')).toBe(
      true,
    );
    expect(GUARDRAIL_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});
