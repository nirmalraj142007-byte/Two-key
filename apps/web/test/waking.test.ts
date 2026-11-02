import { createDb, hijackAttempts } from '@twokey/db';
import { createTestDatabase, testDatabaseUrl } from '@twokey/db/testing';
import { sql } from 'drizzle-orm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunNote } from '@/app/agent/console';
import { wakeServices, wakeTargets } from '@/lib/wake';
import {
  HIJACK_SLOW_MS,
  HIJACK_WAKING_LIMIT_MS,
  hijackReplayDue,
  isWaking,
  WAKING_AFTER_MS,
  WAKING_TEXT,
} from '@/lib/waking';

// Free hosting (plan B): services sleep, so a cold start must read as "waking", never as a
// failure, and must not push the hijack box into a recorded run early.

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
// The console's server actions (and their sign-in imports) are not needed to render RunNote.
vi.mock('@/app/agent/actions', () => ({
  recentProposals: vi.fn(),
  runStatus: vi.fn(),
  startRun: vi.fn(),
}));
const replays = vi.fn(async (_job: { attemptId: string; reason: string }) => undefined);
vi.mock('@/lib/jobs', () => ({
  enqueueHijackReplay: replays,
  enqueueHijackRun: vi.fn(),
}));

describe('waking rules', () => {
  it('says "waking" only after 5 s without a step', () => {
    expect(isWaking(WAKING_AFTER_MS - 1, false)).toBe(false);
    expect(isWaking(WAKING_AFTER_MS, false)).toBe(true);
    expect(isWaking(60_000, true)).toBe(false);
  });

  it('gives a run that has not started 75 s before a replay, a started one 30 s', () => {
    expect(hijackReplayDue(HIJACK_SLOW_MS, false)).toBe(false);
    expect(hijackReplayDue(HIJACK_WAKING_LIMIT_MS - 1, false)).toBe(false);
    expect(hijackReplayDue(HIJACK_WAKING_LIMIT_MS, false)).toBe(true);
    expect(hijackReplayDue(HIJACK_SLOW_MS, true)).toBe(true);
    expect(HIJACK_WAKING_LIMIT_MS).toBe(75_000);
  });

  it('the console shows the waking sentence instead of a blank wait', () => {
    const run = { status: 'running' as const, message: 'shoes', sessionId: 's' };
    const html = (waking: boolean) =>
      renderToStaticMarkup(createElement(RunNote, { run, waking, onRetry: () => undefined }));
    expect(html(true)).toContain(WAKING_TEXT);
    expect(html(false)).toContain('The agent is shopping…');
    expect(html(false)).not.toContain(WAKING_TEXT);
  });
});

describe('wake pings', () => {
  it('targets agent-runner and twokey-mcp /healthz, once each', () => {
    expect(
      wakeTargets({
        AGENT_RUNNER_URL: 'https://runner.example.test',
        MCP_PUBLIC_URL: 'https://mcp.example.test/mcp',
      }),
    ).toEqual(['https://runner.example.test/healthz', 'https://mcp.example.test/healthz']);
    expect(wakeTargets({ MCP_PUBLIC_URL: 'http://localhost:4100/mcp' })).toEqual([
      'http://localhost:4100/healthz',
    ]);
  });

  it('never waits for or fails on the ping', async () => {
    let resolve: (r: Response) => void = () => undefined;
    const slow = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(wakeServices(['https://runner.example.test/healthz'], slow as typeof fetch)).toBe(
      undefined,
    );
    wakeServices(['https://mcp.example.test/healthz'], failing as typeof fetch);
    await new Promise((r) => setTimeout(r, 0));
    expect(slow).toHaveBeenCalledWith(
      'https://runner.example.test/healthz',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(failing).toHaveBeenCalledTimes(1);
    resolve(new Response('ok'));
  });
});

const baseUrl = testDatabaseUrl();

describe.skipIf(!baseUrl)('hijack slow replay on a cold start', () => {
  let drop: () => Promise<void>;
  let conn: ReturnType<typeof createDb>;
  let POST: typeof import('@/app/api/hijack/[attemptId]/replay/route').POST;

  beforeAll(async () => {
    let url: string;
    ({ url, drop } = await createTestDatabase(baseUrl as string));
    env.DATABASE_URL = url;
    conn = createDb(url);
    ({ POST } = await import('@/app/api/hijack/[attemptId]/replay/route'));
  }, 60_000);

  afterAll(async () => {
    const g = globalThis as { twokeyDb?: { $client?: { end?: () => Promise<void> } } };
    await g.twokeyDb?.$client?.end?.();
    await conn?.sql.end();
    await drop?.();
  });

  beforeEach(async () => {
    replays.mockClear();
    await conn.db.delete(hijackAttempts);
  });

  /** A live attempt still running, created `ageS` seconds ago. */
  async function attempt(ageS: number): Promise<string> {
    const [row] = await conn.db
      .insert(hijackAttempts)
      .values({
        ipHash: 'h',
        injectionText: 'x',
        model: env.AGENT_MODEL,
        status: 'running',
        mode: 'live',
        createdAt: sql`now() - make_interval(secs => ${ageS})`,
      })
      .returning({ id: hijackAttempts.id });
    return (row as { id: string }).id;
  }

  const ask = async (attemptId: string, body?: unknown) => {
    const res = await POST(
      new Request(`http://localhost/api/hijack/${attemptId}/replay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { params: Promise.resolve({ attemptId }) } as never,
    );
    return ((await res.json()) as { replaying: boolean }).replaying;
  };

  it('keeps waiting at 40 s while the agent has not started (services waking)', async () => {
    const id = await attempt(40);
    expect(await ask(id, { started: false })).toBe(false);
    expect(await ask(id)).toBe(false);
    expect(replays).not.toHaveBeenCalled();
  });

  it('replays a run that never started once it is 75 s old', async () => {
    const id = await attempt(76);
    expect(await ask(id, { started: false })).toBe(true);
    expect(replays).toHaveBeenCalledWith({ attemptId: id, reason: 'slow' });
  });

  it('still replays a started but slow run after 30 s', async () => {
    const id = await attempt(31);
    expect(await ask(id, { started: true })).toBe(true);
  });
});
