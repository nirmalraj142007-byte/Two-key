import { AppError, ErrorCode } from '@twokey/core';
import { describe, expect, it } from 'vitest';
import { adapterFor } from '../src/adapters/index.js';
import type { Msg } from '../src/adapters/types.js';
import { priceFor } from '../src/pricing.js';

const cfg = { AGENT_LLM_BASE_URL: 'https://example.test/v1' };
const step = (messages: Msg[]) => ({
  system: '',
  messages,
  tools: [],
  maxOutputTokens: 100,
  temperature: 0,
});

const SEARCH = `Found 2 products.\n${JSON.stringify({
  items: [
    { product_id: 'p-gift', title: 'Digital gift card $189', store: 'GiftVault' },
    { product_id: 'p-cr1', title: 'Cloud Runner CR-1 running shoe', store: 'Stride Supply' },
    { product_id: 'p-cr1-peak', title: 'Cloud Runner CR-1 running shoe', store: 'Peak Outfitters' },
  ],
})}`;

describe('scripted adapter', () => {
  it('is refused in production unless ALLOW_SCRIPTED=true', () => {
    const prod = { ...cfg, NODE_ENV: 'production' as const };
    expect(() => adapterFor('scripted:happy', prod)).toThrow(AppError);
    try {
      adapterFor('scripted:happy', prod);
    } catch (err) {
      expect((err as AppError).code).toBe(ErrorCode.CONFIG_INVALID);
    }
    expect(() => adapterFor('scripted:happy', { ...prod, ALLOW_SCRIPTED: 'false' })).toThrow(
      AppError,
    );
    expect(adapterFor('scripted:happy', { ...prod, ALLOW_SCRIPTED: 'true' }).id).toBe(
      'scripted:happy',
    );
  });

  it('is allowed outside production', () => {
    expect(adapterFor('scripted:happy', { ...cfg, NODE_ENV: 'development' }).id).toBe(
      'scripted:happy',
    );
    expect(adapterFor('scripted:attack', cfg).id).toBe('scripted:attack');
  });

  it('refuses unknown scripts and path tricks', () => {
    for (const name of ['nope', '../happy', 'a/b', '']) {
      expect(() => adapterFor(`scripted:${name}`, cfg)).toThrow(AppError);
    }
  });

  it('plays happy: search, propose the Stride Supply listing, end', async () => {
    const a = adapterFor('scripted:happy', cfg);
    const messages: Msg[] = [{ role: 'user', text: 'buy shoes' }];

    const s1 = await a.step(step(messages));
    expect(s1.stop).toBe('tool');
    expect(s1.toolCalls[0]).toMatchObject({
      name: 'search_products',
      input: { query: 'cloud runner' },
    });
    messages.push({ role: 'assistant', text: s1.text, toolCalls: s1.toolCalls });
    messages.push({ role: 'tool', toolCallId: s1.toolCalls[0]?.id, toolResult: SEARCH });

    const s2 = await a.step(step(messages));
    expect(s2.toolCalls[0]).toMatchObject({
      name: 'propose_purchase',
      input: { product_id: 'p-cr1', qty: 1 },
    });
    messages.push({ role: 'assistant', text: s2.text, toolCalls: s2.toolCalls });

    const s3 = await a.step(step(messages));
    expect(s3.stop).toBe('end');
    expect(s3.toolCalls).toEqual([]);
    messages.push({ role: 'assistant', text: s3.text });
    // Past the end of the script it stays finished.
    expect((await a.step(step(messages))).stop).toBe('end');
  });

  it('plays attack: proposes the $189 GiftVault card', async () => {
    const a = adapterFor('scripted:attack', cfg);
    const messages: Msg[] = [
      { role: 'user', text: 'buy shoes' },
      { role: 'assistant', toolCalls: [{ id: 'x', name: 'search_products', input: {} }] },
      { role: 'tool', toolCallId: 'x', toolResult: SEARCH },
    ];
    const s = await a.step(step(messages));
    expect(s.toolCalls[0]?.input).toEqual({ product_id: 'p-gift', qty: 1 });
  });

  it('fails the run when the listing is not in the search result', async () => {
    const a = adapterFor('scripted:anomaly', cfg);
    const messages: Msg[] = [
      { role: 'user', text: 'x' },
      { role: 'assistant', toolCalls: [{ id: 'x', name: 'search_products', input: {} }] },
      { role: 'tool', toolCallId: 'x', toolResult: SEARCH },
    ];
    await expect(a.step(step(messages))).rejects.toThrow(AppError);
  });

  it('is priced at zero', () => {
    expect(priceFor('scripted:happy').inputPerMTok).toBe(0);
  });
});
