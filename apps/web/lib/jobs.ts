import { createLogger } from '@twokey/core';
import { pgBossConnection } from '@twokey/db';
import { PgBoss } from 'pg-boss';
import { webEnv } from './env';

/** Must match apps/agent-runner/src/worker.ts (`.live`: the evaluation stack never consumes these). */
export const AGENT_RUN_QUEUE = 'agent.run.live';
export const SCRIPTED_RUN_QUEUE = 'agent.run.scripted';
export const HIJACK_RUN_QUEUE = 'hijack.run.live';
export const HIJACK_REPLAY_QUEUE = 'hijack.replay.live';
const QUEUES = [AGENT_RUN_QUEUE, SCRIPTED_RUN_QUEUE, HIJACK_RUN_QUEUE, HIJACK_REPLAY_QUEUE];

export interface AgentRunJob {
  sessionId: string;
  userId: string;
  /** The session's agent token; the runner sends it to MCP and scrubs it from transcripts. */
  token: string;
  userMessage: string;
  model: string;
  mode: 'demo';
}

// Send-only: no supervision or schedules here; the agent runner and gateway do that work.
// One instance per server process; dev reloads reuse it through globalThis.
const g = globalThis as { twokeyBoss?: Promise<PgBoss> };

function boss(): Promise<PgBoss> {
  g.twokeyBoss ??= (async () => {
    const b = new PgBoss({
      ...pgBossConnection(webEnv().DATABASE_URL, 'twokey-web'),
      supervise: false,
      schedule: false,
    });
    const log = createLogger('web', webEnv().LOG_LEVEL);
    b.on('error', (err) => log.error({ err }, 'pg-boss error'));
    await b.start();
    for (const queue of QUEUES) {
      if (!(await b.getQueue(queue))) await b.createQueue(queue, { retryLimit: 0 });
    }
    return b;
  })().catch((err) => {
    g.twokeyBoss = undefined;
    throw err;
  });
  return g.twokeyBoss;
}

export async function enqueueAgentRun(job: AgentRunJob): Promise<void> {
  const b = await boss();
  const id = await b.send(
    job.model.startsWith('scripted:') ? SCRIPTED_RUN_QUEUE : AGENT_RUN_QUEUE,
    job,
  );
  if (!id) throw new Error('agent run was not queued');
}

export interface HijackRunJob extends Omit<AgentRunJob, 'mode'> {
  attemptId: string;
}

/** A live hijack box run; the runner records its result card on the attempt. */
export async function enqueueHijackRun(job: HijackRunJob): Promise<void> {
  const id = await (await boss()).send(HIJACK_RUN_QUEUE, job);
  if (!id) throw new Error('hijack.run was not queued');
}

/** A recorded run shown in place of a live one (caps reached, or the live model too slow). */
export async function enqueueHijackReplay(job: {
  attemptId: string;
  reason: 'caps' | 'slow' | 'failed' | 'model';
}): Promise<void> {
  const id = await (await boss()).send(HIJACK_REPLAY_QUEUE, job);
  if (!id) throw new Error('hijack.replay was not queued');
}
