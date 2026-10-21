import { readFileSync } from 'node:fs';
import { AppError, ErrorCode, type Registry, RuleCardSchema } from '@twokey/core';
import { describe, expect, it, vi } from 'vitest';
import type { CompilerClient, ToolCallParams, ToolCallResult } from '../lib/llm';
import { withRetry } from '../lib/llm';
import { compileRules } from '../lib/rule-compiler';

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const registry: Registry = [
  { slug: 'stride-supply', id: id(1), displayName: 'Stride Supply', categories: ['running_shoes'] },
  {
    slug: 'peak-outfitters',
    id: id(2),
    displayName: 'Peak Outfitters',
    categories: ['running_shoes'],
  },
  { slug: 'corner-pantry', id: id(3), displayName: 'Corner Pantry', categories: ['household'] },
];

const NOW = new Date('2026-10-21T00:00:00Z');
const USER = id(9);
const DEMO =
  'Running shoes, size 10, under $70, only Stride Supply or Peak Outfitters, one pair, this week.';

const output = (over: Record<string, unknown> = {}) => ({
  perItemCapUsd: 70,
  perOrderCapUsd: null,
  stores: ['stride-supply', 'peak-outfitters'],
  categories: null,
  maxQty: 1,
  frequency: null,
  expiresInDays: 7,
  advisory: [{ key: 'size', value: '10', label: 'Size' }],
  unclear: [],
  ...over,
});

function fakeClient(...inputs: unknown[]): CompilerClient & { calls: ToolCallParams[] } {
  const calls: ToolCallParams[] = [];
  return {
    provider: 'openai-compatible',
    model: 'fake-model',
    pricePerMTok: { input: 0, output: 0 },
    calls,
    async callTool(p): Promise<ToolCallResult> {
      calls.push(p);
      return {
        input: inputs[Math.min(calls.length - 1, inputs.length - 1)],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

const deps = (client: CompilerClient) => ({
  client,
  now: NOW,
  userId: USER,
  spend: vi.fn(async () => {}),
  defaults: {
    frequency: { maxPurchases: 5, windowHours: 24 },
    holdTimeoutMinutes: 15,
    expiresInDays: 30,
  },
});

describe('compileRules', () => {
  it('turns the demo request into a draft card with per-field enforcement', async () => {
    const client = fakeClient(output());
    const d = deps(client);
    const r = await compileRules(DEMO, registry, d);

    expect(r.needsInput).toEqual([]);
    expect(r.card).not.toBeNull();
    expect(RuleCardSchema.safeParse(r.card).success).toBe(true);
    expect(r.card).toMatchObject({
      userId: USER,
      perItemCapCents: 7000,
      perOrderCapCents: 7000,
      allowedMerchantIds: [id(1), id(2)],
      maxQtyPerOrder: 1,
      holdTimeoutMinutes: 15,
      expiresAt: '2026-10-28T00:00:00.000Z',
      frequency: { maxPurchases: 5, windowHours: 24 },
    });
    expect(r.advisory).toEqual([{ key: 'size', value: '10', label: 'Size' }]);
    expect(r.enforcement).toEqual({
      perItemCapCents: 'enforced',
      perOrderCapCents: 'default',
      allowedMerchantIds: 'enforced',
      maxQtyPerOrder: 'enforced',
      frequency: 'default',
      expiresAt: 'enforced',
      holdTimeoutMinutes: 'default',
      size: 'advisory',
    });
    expect(d.spend).toHaveBeenCalledTimes(1);
  });

  it('payload contains no listing text and exactly one user message', async () => {
    const catalog = JSON.parse(
      readFileSync(new URL('../../../packages/db/seed/demo-catalog.json', import.meta.url), 'utf8'),
    ) as { description: string }[];
    expect(catalog.length).toBeGreaterThan(0);
    const client = fakeClient(output());
    await compileRules(DEMO, registry, deps(client));

    const payload = JSON.stringify(client.calls);
    for (const { description } of catalog) expect(payload).not.toContain(description);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({ temperature: 0, maxTokens: 1024 });
    expect(client.calls[0]?.tool.name).toBe('emit_rules');
  });

  it('drops unknown stores with a warning', async () => {
    const client = fakeClient(output({ stores: ['stride-supply', 'giftvault'] }));
    const r = await compileRules('shoes under $70', registry, deps(client));
    expect(r.warnings).toContain('giftvault is not in your stores');
    expect(r.card?.allowedMerchantIds).toEqual([id(1)]);
  });

  it('asks for the missing pieces instead of building a card', async () => {
    const noCap = await compileRules(
      'stride only',
      registry,
      deps(fakeClient(output({ perItemCapUsd: null }))),
    );
    expect(noCap.card).toBeNull();
    expect(noCap.needsInput).toEqual(['a price cap']);

    const noStore = await compileRules(
      'anything',
      registry,
      deps(fakeClient(output({ stores: ['giftvault'] }))),
    );
    expect(noStore.card).toBeNull();
    expect(noStore.needsInput).toEqual(['at least one store']);
  });

  it('retries once on a schema failure, then fails as UPSTREAM_LLM', async () => {
    const recovered = fakeClient({ nope: true }, output());
    const r = await compileRules(DEMO, registry, deps(recovered));
    expect(r.card).not.toBeNull();
    expect(recovered.calls).toHaveLength(2);
    expect(recovered.calls[1]?.messages).toHaveLength(1);
    expect(recovered.calls[1]?.messages[0]?.content).toContain('previous output was invalid');

    const broken = fakeClient({ nope: true });
    await expect(compileRules(DEMO, registry, deps(broken))).rejects.toMatchObject({
      code: ErrorCode.UPSTREAM_LLM,
    });
    expect(broken.calls).toHaveLength(2);
  });

  it('rejects empty and oversized requests before any model call', async () => {
    const client = fakeClient(output());
    await expect(compileRules('   ', registry, deps(client))).rejects.toBeInstanceOf(AppError);
    await expect(compileRules('x'.repeat(1001), registry, deps(client))).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
    });
    expect(client.calls).toHaveLength(0);
  });
});

describe('withRetry', () => {
  const httpError = (status: number) => Object.assign(new Error('boom'), { status });

  it('retries a 529 once and succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(httpError(529)).mockResolvedValue('ok');
    const sleep = vi.fn(async () => {});
    await expect(withRetry(fn, sleep)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('gives up after two retries as a retryable UPSTREAM_LLM', async () => {
    const fn = vi.fn().mockRejectedValue(httpError(500));
    await expect(withRetry(fn, async () => {})).rejects.toMatchObject({
      code: ErrorCode.UPSTREAM_LLM,
      retryable: true,
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 400', async () => {
    const fn = vi.fn().mockRejectedValue(httpError(400));
    await expect(withRetry(fn, async () => {})).rejects.toMatchObject({
      code: ErrorCode.UPSTREAM_LLM,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('honours retry-after', async () => {
    const err = Object.assign(new Error('slow down'), {
      status: 429,
      headers: new Headers({ 'retry-after': '2' }),
    });
    const sleep = vi.fn(async () => {});
    await withRetry(vi.fn().mockRejectedValueOnce(err).mockResolvedValue(1), sleep);
    const waited = (sleep.mock.calls[0] as unknown as [number])[0];
    expect(waited).toBeGreaterThanOrEqual(2000);
    expect(waited).toBeLessThan(2250);
  });
});
