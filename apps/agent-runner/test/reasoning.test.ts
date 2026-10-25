import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createOpenAICompatibleAdapter } from '../src/adapters/openai-compatible.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** Serves one recorded Groq response and remembers the request body. */
async function serve(body: string) {
  const seen: { body?: Record<string, unknown> } = {};
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/openai/v1`;
  return { seen, baseURL, close: () => new Promise((r) => server.close(r)) };
}

describe.each([
  ['openai/gpt-oss-20b', 'groq-gpt-oss-20b.json', /call the buy function/],
  ['qwen/qwen3.8-27b', 'groq-qwen3.8-27b.json', /I'll call it with id "7"/],
])('reasoning capture: %s', (model, file, expected) => {
  it('requests reasoning and returns it next to an empty text', async () => {
    const srv = await serve(fixture(file));
    try {
      const adapter = createOpenAICompatibleAdapter(model, { apiKey: 'k', baseURL: srv.baseURL });
      const step = await adapter.step({
        system: 's',
        messages: [{ role: 'user', text: 'Buy item 7.' }],
        tools: [{ name: 'buy', description: 'buy', inputSchema: { type: 'object' } }],
        maxOutputTokens: 100,
        temperature: 0,
      });
      expect(srv.seen.body?.reasoning_effort).toBe('medium');
      expect(step.text).toBe('');
      expect(step.reasoning).toMatch(expected);
      expect(step.toolCalls).toEqual([{ id: expect.any(String), name: 'buy', input: { id: '7' } }]);
      expect(step.stop).toBe('tool');
    } finally {
      await srv.close();
    }
  });
});
