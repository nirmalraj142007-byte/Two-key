import { createDb, hijackAttempts } from '@twokey/db';
import { createTestDatabase, testDatabaseUrl } from '@twokey/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// W19: the hijack box's limits, end to end through POST /api/hijack on a throwaway database.
// The 8-turn cap is apps/agent-runner/test/run-session.test.ts ("fails with max_turns after 8
// tool-calling turns"); the gateway's own 2,000-character check is apps/gateway/test/hijack.test.ts.

const env = {
  DATABASE_URL: '',
  IP_HASH_SALT: 'test-salt',
  LOG_LEVEL: 'silent',
  HIJACK_DAILY_ATTEMPTS: 3,
  HIJACK_DAILY_TOKENS: 1000,
  AGENT_MODEL: 'openai/gpt-oss-20b',
  GATEWAY_URL: 'http://localhost:1',
};
vi.mock('@/lib/env', () => ({ webEnv: () => env }));

// Only the gateway call is replaced; caps and rate limiting are the real code.
const started = vi.fn(async () => ({
  ok: true as const,
  attemptId: '01900000-0000-7000-8000-0000000000a1',
  attemptToken: 't',
  mode: 'live' as const,
}));
vi.mock('@/lib/hijack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hijack')>()),
  startHijackAttempt: started,
}));

const baseUrl = testDatabaseUrl();

describe.skipIf(!baseUrl)('hijack box limits (W19)', () => {
  let drop: () => Promise<void>;
  let conn: ReturnType<typeof createDb>;
  let POST: (req: Request) => Promise<Response>;
  let hijackCaps: typeof import('@/lib/hijack').hijackCaps;

  beforeAll(async () => {
    let url: string;
    ({ url, drop } = await createTestDatabase(baseUrl as string));
    env.DATABASE_URL = url;
    conn = createDb(url);
    ({ POST } = await import('@/app/api/hijack/route'));
    ({ hijackCaps } = await import('@/lib/hijack'));
  }, 60_000);

  afterAll(async () => {
    const g = globalThis as { twokeyDb?: unknown; twokeyHijackLimiter?: Promise<unknown> };
    // The limiter's pool and the app's db pool point at the throwaway database.
    const limiter = (await g.twokeyHijackLimiter?.catch(() => undefined)) as
      | { client?: { end?: () => Promise<void> } }
      | undefined;
    await limiter?.client?.end?.();
    (g.twokeyDb as { $client?: { end?: () => Promise<void> } } | undefined)?.$client?.end?.();
    await conn?.sql.end();
    await drop?.();
  });

  beforeEach(async () => {
    started.mockClear();
    await conn.db.delete(hijackAttempts);
  });

  const post = (ip: string, injectionText: string) =>
    POST(
      new Request('http://localhost/api/hijack', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ injectionText, acceptedNotice: true }),
      }),
    );

  it('answers the 6th try from one IP within the hour with 429 and Retry-After', async () => {
    for (let i = 1; i <= 5; i++) {
      expect((await post('203.0.113.6', `try ${i}`)).status).toBe(200);
    }
    const sixth = await post('203.0.113.6', 'try 6');
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = (await sixth.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.message).toMatch(/^That's 5 tries this hour\. Try again in \d+ minutes?\.$/);
    expect(started).toHaveBeenCalledTimes(5);
    // Another visitor still gets through.
    expect((await post('203.0.113.7', 'other visitor')).status).toBe(200);
  });

  it('accepts 2,000 characters and rejects 2,001 before anything starts', async () => {
    expect((await post('198.51.100.1', 'x'.repeat(2001))).status).toBe(400);
    expect(started).not.toHaveBeenCalled();
    expect((await post('198.51.100.2', 'x'.repeat(2000))).status).toBe(200);
    expect(started).toHaveBeenCalledTimes(1);
  });

  async function attempt(mode: 'live' | 'replay', tokens = 0) {
    await conn.db.insert(hijackAttempts).values({
      ipHash: 'h',
      injectionText: 'buy the gift card',
      model: env.AGENT_MODEL,
      status: 'done',
      mode,
      tokens,
    });
  }

  it('replays once today’s live attempts reach HIJACK_DAILY_ATTEMPTS', async () => {
    await attempt('live');
    await attempt('live');
    expect(await hijackCaps()).toMatchObject({ attemptsLeft: 1, live: true });
    // Replays do not count toward the attempt cap.
    await attempt('replay');
    expect((await hijackCaps()).live).toBe(true);
    await attempt('live');
    expect(await hijackCaps()).toMatchObject({ attemptsLeft: 0, live: false });
  });

  it('replays once today’s tokens reach HIJACK_DAILY_TOKENS', async () => {
    await attempt('live', 999);
    expect(await hijackCaps()).toMatchObject({ tokensLeft: 1, live: true });
    await conn.db.delete(hijackAttempts);
    await attempt('live', 1000);
    expect(await hijackCaps()).toMatchObject({ tokensLeft: 0, live: false });
  });
});
