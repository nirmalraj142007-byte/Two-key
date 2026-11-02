import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { connectWithRetry, MCP_CONNECT_DEADLINE_MS } from '../src/run-session.js';

// Free hosting: twokey-mcp may be asleep when a run starts. The runner keeps trying for about a
// minute instead of failing the run (which would send the hijack box to a replay).

function clock() {
  let t = 0;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    waits,
  };
}

describe('connectWithRetry', () => {
  it('rides out a cold start: network errors and 502/503 until twokey-mcp answers', async () => {
    const c = clock();
    const errors = [
      new TypeError('fetch failed'),
      new StreamableHTTPError(502, 'Bad Gateway'),
      new StreamableHTTPError(503, 'Service Unavailable'),
    ];
    let calls = 0;
    const client = await connectWithRetry(
      async () => {
        calls++;
        const err = errors.shift();
        if (err) throw err;
        return 'connected';
      },
      { now: c.now, sleep: c.sleep },
    );
    expect(client).toBe('connected');
    expect(calls).toBe(4);
    expect(c.waits).toEqual([1000, 2000, 4000]);
  });

  it('gives up with the last error after about 60 s', async () => {
    const c = clock();
    let calls = 0;
    await expect(
      connectWithRetry(
        async () => {
          calls++;
          throw new StreamableHTTPError(503, 'still waking');
        },
        { now: c.now, sleep: c.sleep },
      ),
    ).rejects.toThrow('still waking');
    expect(c.waits).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000, 10_000, 10_000]);
    expect(c.now()).toBeLessThanOrEqual(MCP_CONNECT_DEADLINE_MS);
    expect(calls).toBe(9);
  });

  it('does not retry an answer a retry cannot change (401 bad token)', async () => {
    const c = clock();
    let calls = 0;
    await expect(
      connectWithRetry(
        async () => {
          calls++;
          throw new StreamableHTTPError(401, 'Unauthorized');
        },
        { now: c.now, sleep: c.sleep },
      ),
    ).rejects.toThrow('Unauthorized');
    expect(calls).toBe(1);
    expect(c.waits).toEqual([]);
  });
});
