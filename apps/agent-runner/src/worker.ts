import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AppError, type Env, ErrorCode, loadEnv } from '@twokey/core';
import {
  createDb,
  type Db,
  hijackUsageToday,
  pgBossConnection,
  startWithRetry,
  users,
} from '@twokey/db';
import { eq } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { adapterFor } from './adapters/index.js';
import {
  failedOutcome,
  finishLiveAttempt,
  HIJACK_RUN_MAX_TOKENS,
  liveOutcome,
  recordAttemptUsage,
  transcriptTokens,
} from './hijack.js';
import { type ReplayDeps, replayAttempt } from './replay.js';
import { mcpConnector, type RunDeps, runSession, type TranscriptEntry } from './run-session.js';
import { createDbStore, type RunStore } from './store.js';

export const AGENT_RUN_QUEUE = 'agent.run';
/** Hijack box runs and replays have their own queues (web enqueues; only this worker runs them). */
export const HIJACK_RUN_QUEUE = 'hijack.run';
export const HIJACK_REPLAY_QUEUE = 'hijack.replay';
/**
 * Hijack runs are capped by daily attempts and tokens (HIJACK_DAILY_*), not dollars: models are
 * priced at $0. The ledger still records each call under this unreachable cap.
 */
const HIJACK_USD_CAP = 999_999;

const Payload = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  token: z.string().min(1),
  userMessage: z.string().min(1),
  model: z.string().min(1),
  mode: z.enum(['live', 'demo', 'hijack', 'eval']),
});
export type AgentRunPayload = z.infer<typeof Payload>;

const HijackPayload = Payload.omit({ mode: true }).extend({ attemptId: z.uuid() });
export type HijackRunPayload = z.infer<typeof HijackPayload>;
const ReplayPayload = z.object({
  attemptId: z.uuid(),
  reason: z.enum(['caps', 'slow', 'failed', 'model']),
});

type RunnerEnv = Env<'agent-runner'>;
type Logger = { info: (o: object, m: string) => void; error: (o: object, m: string) => void };

function depsFor(
  env: RunnerEnv,
  store: RunStore,
  model: string,
  log: Logger,
  mode: AgentRunPayload['mode'] = 'demo',
): RunDeps {
  return {
    store,
    // Eval sessions go to the eval provider (NIM); live, demo and hijack stay on AGENT_LLM_*.
    adapter: adapterFor(model, env, { purpose: mode === 'eval' ? 'eval' : 'agent' }),
    connect: mcpConnector(env.MCP_URL),
    onError: (err) => log.error({ err }, 'agent run failed'),
    caps: {
      live: env.DAILY_BUDGET_USD_LIVE,
      hijack: HIJACK_USD_CAP,
      eval: env.DAILY_BUDGET_USD_EVAL,
    },
  };
}

const STOPPED_TEXT = {
  max_turns: 'The agent used all its turns without finishing.',
  budget: 'The agent stopped at its token limit.',
  error: 'The agent stopped before finishing.',
} as const;

/**
 * One hijack box attempt, live. Ends with a result card whatever happens: the live outcome, or a
 * replay when today's tokens are used up or the run fails before proposing anything.
 */
export async function runHijack(
  env: Pick<RunnerEnv, 'HIJACK_DAILY_TOKENS' | 'DEMO_EPISODE_ID'>,
  i: {
    db: Db;
    store: RunStore;
    log: Logger;
    run: (p: AgentRunPayload & { maxTotalTokens: number }) => ReturnType<typeof runSession>;
    /** Replay pacing (tests skip the waits). */
    sleep?: ReplayDeps['sleep'];
  },
  payload: HijackRunPayload,
): Promise<void> {
  const { db, store, log } = i;
  const { attemptId, sessionId, userId, model } = payload;
  const replayDeps: ReplayDeps = {
    db,
    store,
    demoEpisodeId: env.DEMO_EPISODE_ID,
    log,
    ...(i.sleep ? { sleep: i.sleep } : {}),
  };
  try {
    const usage = await hijackUsageToday(db);
    const left = env.HIJACK_DAILY_TOKENS - usage.tokens;
    if (left <= 0) {
      await store.finish({ sessionId, status: 'ended', transcript: [] });
      await replayAttempt(replayDeps, attemptId, 'caps');
      return;
    }
    const maxTotalTokens = Math.min(HIJACK_RUN_MAX_TOKENS, left);
    const res = await i.run({ ...payload, mode: 'hijack', maxTotalTokens });
    const tokens = transcriptTokens(res.transcript);
    const cost = res.transcript.reduce((n, e) => n + (e.usage?.costUsd ?? 0), 0);
    // Nothing was proposed: there is no live result to show, so a recorded run stands in.
    if (res.status === 'failed' && res.proposals.length === 0 && res.reason !== 'max_turns') {
      await recordAttemptUsage(db, attemptId, tokens, cost);
      const dailyLimited = res.reason === 'budget' && maxTotalTokens < HIJACK_RUN_MAX_TOKENS;
      await replayAttempt(replayDeps, attemptId, dailyLimited ? 'caps' : 'failed');
      return;
    }
    const outcome = await liveOutcome(db, {
      sessionId,
      model,
      transcript: res.transcript,
      ...(res.status === 'failed' ? { message: STOPPED_TEXT[res.reason ?? 'error'] } : {}),
    });
    if (await finishLiveAttempt(db, attemptId, outcome, tokens, cost)) {
      await store.notify({ type: 'hijack.result', userId, sessionId, outcome });
    }
  } catch (err) {
    log.error({ err, attemptId }, 'hijack run crashed');
    try {
      if (await replayAttempt(replayDeps, attemptId, 'failed')) return;
    } catch (replayErr) {
      log.error({ err: replayErr, attemptId }, 'hijack replay crashed');
    }
    const outcome = failedOutcome(model, 'This attempt could not finish. Try again.');
    if (await finishLiveAttempt(db, attemptId, outcome, 0, 0).catch(() => false)) {
      await store.notify({ type: 'hijack.result', userId, sessionId, outcome }).catch(() => {});
    }
  }
}

/** Subscribes to agent.run: up to 2 sessions at once, never retried (a failed run is a result). */
export async function startWorker(env: RunnerEnv, log: Logger): Promise<() => Promise<void>> {
  const { db, sql } = createDb(env.DATABASE_URL);
  const store = createDbStore(db);
  const make = (): PgBoss => {
    const b = new PgBoss(pgBossConnection(env.DATABASE_URL, 'twokey-agent'));
    b.on('error', (err) => log.error({ err }, 'pg-boss error'));
    return b;
  };
  let boss = make();
  await startWithRetry(
    () => boss.start(),
    async () => {
      await boss.stop({ graceful: false });
      boss = make();
    },
    (err, attempt) => log.error({ err, attempt }, 'pg-boss start failed, retrying'),
  );
  if (!(await boss.getQueue(AGENT_RUN_QUEUE))) {
    await boss.createQueue(AGENT_RUN_QUEUE, { retryLimit: 0 });
  }
  for (const queue of [HIJACK_RUN_QUEUE, HIJACK_REPLAY_QUEUE]) {
    if (!(await boss.getQueue(queue))) await boss.createQueue(queue, { retryLimit: 0 });
  }
  await boss.work<unknown>(HIJACK_RUN_QUEUE, { localConcurrency: 2 }, async (jobs) => {
    for (const job of jobs) {
      const payload = HijackPayload.parse(job.data);
      await runHijack(
        env,
        {
          db,
          store,
          log,
          run: (p) => runSession(depsFor(env, store, p.model, log, 'hijack'), p),
        },
        payload,
      );
      log.info({ sessionId: payload.sessionId }, 'hijack attempt finished');
    }
  });
  await boss.work<unknown>(HIJACK_REPLAY_QUEUE, { localConcurrency: 2 }, async (jobs) => {
    for (const job of jobs) {
      const { attemptId, reason } = ReplayPayload.parse(job.data);
      await replayAttempt(
        { db, store, demoEpisodeId: env.DEMO_EPISODE_ID, log },
        attemptId,
        reason,
      );
    }
  });
  await boss.work<unknown>(AGENT_RUN_QUEUE, { localConcurrency: 2 }, async (jobs) => {
    for (const job of jobs) {
      const payload = Payload.parse(job.data);
      try {
        const res = await runSession(
          depsFor(env, store, payload.model, log, payload.mode),
          payload,
        );
        log.info(
          { sessionId: payload.sessionId, status: res.status, reason: res.reason },
          'agent run finished',
        );
      } catch (err) {
        log.error({ sessionId: payload.sessionId, err }, 'agent run crashed');
        throw err;
      }
    }
  });
  log.info({ queue: AGENT_RUN_QUEUE }, 'agent worker started');
  return async () => {
    await boss.stop({ graceful: true, timeout: 10_000 });
    await sql.end();
  };
}

// ---- agent:once -------------------------------------------------------------------------

function show(entry: TranscriptEntry): void {
  const head = `turn ${entry.turn} [${entry.role}${entry.toolName ? ` ${entry.toolName}` : ''}]`;
  const calls = (entry.toolCalls ?? [])
    .map((c) => `\n    -> ${c.name}(${JSON.stringify(c.input)})`)
    .join('');
  const text = entry.text.length > 400 ? `${entry.text.slice(0, 400)}…` : entry.text;
  console.log(`${head} ${text}${calls}`);
}

/** Mints a demo session the way web does (the runner itself holds no signing key). */
async function mintSession(
  email: string,
  model: string,
): Promise<{ sessionId: string; token: string }> {
  const script = resolve(fileURLToPath(import.meta.url), '../../../../scripts/mint-assertion.ts');
  const assertion = execFileSync(
    process.execPath,
    ['--import', 'tsx', script, email, 'sessions:create'],
    { encoding: 'utf8', cwd: resolve(script, '../..') },
  ).trim();
  const gateway = process.env.GATEWAY_URL ?? 'http://localhost:4000';
  const res = await fetch(`${gateway}/human/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${assertion}` },
    body: JSON.stringify({ mode: 'demo', model }),
  });
  if (!res.ok) {
    throw new AppError(
      ErrorCode.UPSTREAM_PAYPAL,
      `POST /human/sessions: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as { sessionId: string; token: string };
}

async function once(): Promise<void> {
  const { values } = parseArgs({
    options: {
      model: { type: 'string' },
      message: { type: 'string' },
      email: { type: 'string', default: 'e2e@twokey.demo' },
    },
    allowPositionals: true,
    strict: false,
  });
  const env = loadEnv('agent-runner');
  const model = typeof values.model === 'string' ? values.model : env.AGENT_MODEL;
  const message = values.message;
  if (typeof message !== 'string' || message === '') {
    throw new AppError(
      ErrorCode.VALIDATION,
      'usage: agent:once -- --model <id> --message "<text>"',
    );
  }
  const email = typeof values.email === 'string' ? values.email : 'e2e@twokey.demo';

  const { db, sql } = createDb(env.DATABASE_URL);
  const dbStore = createDbStore(db);
  const store: RunStore = {
    ...dbStore,
    async notify(payload) {
      show((payload as { entry: TranscriptEntry }).entry);
      await dbStore.notify(payload);
    },
  };
  try {
    const { sessionId, token } = await mintSession(email, model);
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (!user) throw new AppError(ErrorCode.NOT_FOUND, `no user ${email}`);
    console.log(`session ${sessionId} model ${model}`);
    const result = await runSession(
      depsFor(env, store, model, {
        info: () => {},
        error: (o) =>
          console.error(String((o as { err?: Error }).err?.message ?? 'agent run failed')),
      }),
      {
        sessionId,
        userId: user.id,
        token,
        userMessage: message,
        model,
        mode: 'demo',
      },
    );
    console.log(
      result.status === 'ended'
        ? `ended: ${result.proposals.length} proposal(s)`
        : `failed: ${result.code ?? result.reason}`,
    );
    if (result.status === 'failed') process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--once')) {
    once().catch((err) => {
      console.error(err instanceof AppError ? `${err.code}: ${err.message}` : err);
      process.exit(1);
    });
  }
}
