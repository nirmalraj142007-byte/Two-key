import { createLogger } from '@twokey/core';
import { pgBossConnection } from '@twokey/db';
import { PgBoss } from 'pg-boss';
import { webEnv } from './env';

/** Must match apps/agent-runner/src/worker.ts. */
export const AGENT_RUN_QUEUE = 'agent.run';

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
    if (!(await b.getQueue(AGENT_RUN_QUEUE))) {
      await b.createQueue(AGENT_RUN_QUEUE, { retryLimit: 0 });
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
  const id = await b.send(AGENT_RUN_QUEUE, job);
  if (!id) throw new Error('agent.run was not queued');
}
