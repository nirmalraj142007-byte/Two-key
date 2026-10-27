import type { Db } from '@twokey/db';
import { agentSessions, evalEpisodes, evalRuns, evalTasks } from '@twokey/db';
import { and, eq, sql } from 'drizzle-orm';
import { GROQ_FREE_LIMITS } from './ratelimit.js';
import type { Split } from './run.js';

export interface ModelStatus {
  model: string;
  done: number;
  total: number;
  /** Episodes that started a session but have no recorded run (timeouts, provider failures). */
  notRecorded: number;
  avgTokensPerRun: number | null;
  /** Groq-served models only: remaining runs × average tokens ÷ tokens per day. */
  projectedDaysLeft: number | null;
}

/** Per model: recorded runs, started-but-unrecorded episodes, average tokens, Groq projection. */
export async function evalStatus(db: Db, split: Split, models: string[]): Promise<ModelStatus[]> {
  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(evalEpisodes)
    .innerJoin(evalTasks, eq(evalTasks.id, evalEpisodes.taskId))
    .where(eq(evalTasks.split, split));

  const runs = await db
    .select({
      model: evalRuns.model,
      done: sql<number>`count(*)::int`,
      tokens: sql<number>`coalesce(sum(${evalRuns.tokensIn} + ${evalRuns.tokensOut}), 0)::float8`,
    })
    .from(evalRuns)
    .innerJoin(evalEpisodes, eq(evalEpisodes.id, evalRuns.episodeId))
    .innerJoin(evalTasks, eq(evalTasks.id, evalEpisodes.taskId))
    .where(eq(evalTasks.split, split))
    .groupBy(evalRuns.model);

  const unrecorded = await db
    .select({
      model: agentSessions.model,
      n: sql<number>`count(distinct ${agentSessions.evalEpisodeId})::int`,
    })
    .from(agentSessions)
    .innerJoin(evalEpisodes, eq(evalEpisodes.id, agentSessions.evalEpisodeId))
    .innerJoin(evalTasks, eq(evalTasks.id, evalEpisodes.taskId))
    .where(
      and(
        eq(agentSessions.mode, 'eval'),
        eq(evalTasks.split, split),
        sql`not exists (select 1 from ${evalRuns} r
          where r.episode_id = ${agentSessions.evalEpisodeId} and r.model = ${agentSessions.model})`,
      ),
    )
    .groupBy(agentSessions.model);

  const names = [
    ...new Set([...models, ...runs.map((r) => r.model), ...unrecorded.map((u) => u.model)]),
  ];
  return names.map((model) => {
    const r = runs.find((x) => x.model === model);
    const done = r?.done ?? 0;
    const avg = done > 0 && r ? r.tokens / done : null;
    const limits = GROQ_FREE_LIMITS[model];
    return {
      model,
      done,
      total,
      notRecorded: unrecorded.find((u) => u.model === model)?.n ?? 0,
      avgTokensPerRun: avg,
      projectedDaysLeft:
        limits && avg !== null ? ((total - done) * avg) / limits.tokensPerDay : null,
    };
  });
}
