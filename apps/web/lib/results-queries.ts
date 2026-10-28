import { AppError, ErrorCode } from '@twokey/core';
import { evalEpisodes, evalRuns, evalTasks, predictions } from '@twokey/db';
import checkpointsFile from '@twokey/eval/frozen/checkpoints.json';
import manifest from '@twokey/eval/frozen/manifest.json';
// One implementation: the explorer runs the same row loader and computation as `eval metrics`
// (computeMetrics there = loadMetricsRows + computeMetricsFrom + a file write we skip here).
import {
  computeMetricsFrom,
  loadMetricsRows,
  type Metrics,
  type ModelMetrics,
} from '@twokey/eval/src/metrics';
import { asc, count, eq } from 'drizzle-orm';
import { unstable_cache } from 'next/cache';
import { db } from './db';

export type Split = 'dev' | 'test';

/** 3 models × 100 test tasks × (clean + InjecAgent + AgentDojo), fixed by the frozen design. */
export const TEST_RUNS_EXPECTED = 3 * 3 * manifest.counts.tasks.test;
export const REPO_URL = 'https://github.com/nirmalraj142007-byte/Two-key';

export interface PredictionView {
  metric: string;
  model: string | null;
  gate: string | null;
  low: number;
  high: number;
  actual: number | null;
  hit: boolean | null;
}

export interface CheckpointView {
  id: string;
  gate: string;
  label: string;
  criterion: string;
  verifiedAt: string | null;
  evidence: string;
  /** Dev checkpoint only: computed from the dev metrics. */
  result?: { model: string; followed: number; attacked: number; passed: boolean } | null;
}

export interface ResultsSummary {
  /** The split every number on the page comes from. */
  split: Split;
  /** The test split runs in the background; it is shown only once complete. */
  testProgress: { runs: number; expected: number; complete: boolean };
  gateVersion: string;
  models: Record<string, ModelMetrics>;
  pooled: Metrics['pooled'];
  attackerMoneyCentsG4: number;
  /** Identical to `eval metrics` totals. */
  totals: Metrics['totals'];
  headline: {
    models: number;
    attacked: number;
    /** Followed outside-the-rules attacks captured under G4, summed over models. */
    attackerPayments: number;
    ruleOfThreePooled: number | null;
  };
  staticCapCents: number;
  predictions: {
    registeredCommit: string | null;
    registeredAt: string | null;
    rows: PredictionView[];
  };
  checkpoints: CheckpointView[];
  repoUrl: string;
}

async function countTestRuns(): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(evalRuns)
    .innerJoin(evalEpisodes, eq(evalEpisodes.id, evalRuns.episodeId))
    .innerJoin(evalTasks, eq(evalTasks.id, evalEpisodes.taskId))
    .where(eq(evalTasks.split, 'test'));
  return row?.n ?? 0;
}

async function metricsFor(split: Split): Promise<Metrics> {
  const { runs, proposals } = await loadMetricsRows(db(), split);
  return computeMetricsFrom(split, runs, proposals);
}

async function loadPredictions(): Promise<ResultsSummary['predictions']> {
  const rows = await db()
    .select()
    .from(predictions)
    .orderBy(asc(predictions.metric), asc(predictions.model), asc(predictions.gate));
  const first = rows[0];
  return {
    registeredCommit: first?.registeredCommit ?? null,
    registeredAt: first ? first.registeredAt.toISOString() : null,
    rows: rows.map((r) => ({
      metric: r.metric,
      model: r.model,
      gate: r.gate,
      low: Number(r.predictedLow),
      high: Number(r.predictedHigh),
      actual: r.actual === null ? null : Number(r.actual),
      hit: r.hit,
    })),
  };
}

function checkpoints(dev: Metrics): CheckpointView[] {
  return checkpointsFile.checkpoints.map((c) => {
    const base: CheckpointView = {
      id: c.id,
      gate: c.gate,
      label: c.label,
      criterion: c.criterion,
      verifiedAt: c.verifiedAt,
      evidence: c.evidence,
    };
    const model = 'model' in c ? c.model : undefined;
    if (c.id !== 'dev' || !model) return base;
    const m = dev.models[model];
    return {
      ...base,
      result: m
        ? { model, followed: m.followed, attacked: m.attacked, passed: m.followed >= 1 }
        : null,
    };
  });
}

async function loadSummary(): Promise<ResultsSummary> {
  const testRuns = await countTestRuns();
  const testComplete = testRuns >= TEST_RUNS_EXPECTED;
  const dev = await metricsFor('dev');
  // A finished test split whose gate decisions are not replayed yet still shows dev.
  const shown = testComplete
    ? await metricsFor('test').catch((err: unknown) => {
        if (err instanceof AppError && err.code === ErrorCode.CONFLICT) return dev;
        throw err;
      })
    : dev;
  const models = Object.values(shown.models);
  return {
    split: shown.split,
    testProgress: { runs: testRuns, expected: TEST_RUNS_EXPECTED, complete: testComplete },
    gateVersion: shown.gateVersion,
    models: shown.models,
    pooled: shown.pooled,
    attackerMoneyCentsG4: shown.attackerMoneyCentsG4,
    totals: shown.totals,
    headline: {
      models: models.length,
      attacked: shown.pooled.attacked,
      attackerPayments: models.reduce((a, m) => a + m.gates.G4.attackerCaptured, 0),
      ruleOfThreePooled: shown.pooled.ruleOfThree,
    },
    staticCapCents: manifest.staticCapCents,
    predictions: await loadPredictions(),
    checkpoints: checkpoints(dev),
    repoUrl: REPO_URL,
  };
}

/** The explorer's numbers, cached for 60 s (tag 'results'). */
export const getResultsSummary = unstable_cache(loadSummary, ['results-summary'], {
  revalidate: 60,
  tags: ['results'],
});
