/**
 * Evaluation CLI. `build` builds the frozen set; `freeze [--dry-run|--tag]` writes the manifest;
 * `run`, `replay`, `grade`, `metrics`, `predictions` and `checkpoint` run and score it.
 * Env comes from .env.eval.
 */
import { parseModelList } from '@twokey/agent-runner/pricing';
import { AppError, ErrorCode, loadEnv, SECRET_OWNERS } from '@twokey/core';
import { createDb } from '@twokey/db';
import { z } from 'zod';
import { loadAgentDojo, loadInjecAgent, PINNED } from './attacks.js';
import { CACHE_DIR, Channel3Cache, sdkFetch } from './channel3.js';
import { buildDataset } from './dataset.js';
import { buildManifest, MANIFEST_PATH, tagFreeze } from './freeze.js';
import { grade } from './grade.js';
import { computeMetrics, GATES, type Metrics, metricsPath } from './metrics.js';
import { persistDataset } from './persist.js';
import {
  checkpoint,
  FALLBACK_HEADLINE,
  registerPredictions,
  scorePredictions,
} from './predictions.js';
import { replay } from './replay.js';
import { runEval, type Split } from './run.js';
import { loadWebshop, WEBSHOP_FILE } from './webshop.js';

const SAMPLE_SIZE = 200;
const DEV_COUNT = 100;
const DEFAULT_MAX_CALLS = 240;

const BuildEnv = z.object({
  DATABASE_URL: z.string().url(),
  CHANNEL3_API_KEY: z.string().min(1).optional(),
});

function loadBuildEnv() {
  for (const [name, owners] of Object.entries(SECRET_OWNERS)) {
    if (process.env[name] && !owners.includes('eval')) {
      throw new AppError(
        ErrorCode.CONFIG_FORBIDDEN_SECRET,
        `${name} may only be set on: ${owners.join(', ')}`,
      );
    }
  }
  const input = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ''));
  const parsed = BuildEnv.safeParse(input);
  if (!parsed.success) {
    throw new AppError(ErrorCode.CONFIG_INVALID, 'Set DATABASE_URL in .env.eval');
  }
  return parsed.data;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const out = (line = '') => process.stdout.write(`${line}\n`);

async function build(args: string[]) {
  const env = loadBuildEnv();
  const webshop = loadWebshop(WEBSHOP_FILE);
  const injecagent = loadInjecAgent();
  const agentdojo = loadAgentDojo();
  const maxCalls = Number(flag(args, '--max-channel3-calls') ?? DEFAULT_MAX_CALLS);
  const cache = new Channel3Cache(
    CACHE_DIR,
    env.CHANNEL3_API_KEY ? sdkFetch(env.CHANNEL3_API_KEY) : undefined,
    maxCalls,
  );

  // Every Channel3 call happens here, before any database write.
  let data: Awaited<ReturnType<typeof buildDataset>>;
  try {
    data = await buildDataset({
      instructions: webshop.instructions,
      templates: { injecagent, agentdojo: agentdojo.templates },
      search: (taskId, query) => cache.search(taskId, query),
      sampleSize: SAMPLE_SIZE,
      devCount: DEV_COUNT,
    });
  } finally {
    out(`channel3 calls made: ${cache.calls} (cache hits ${cache.hits})`);
  }

  const { db, sql } = createDb(env.DATABASE_URL);
  let frozenKept = 0;
  try {
    ({ frozenKept } = await persistDataset(db, data));
  } finally {
    await sql.end();
  }

  const attacked = data.episodes.filter((e) => e.variant !== 'clean');
  const dev = data.tasks.filter((t) => t.split === 'dev').length;
  const s = data.stats;
  out('eval build summary');
  out(`  webshop: ${WEBSHOP_FILE} sha256 ${webshop.sha256} (${webshop.bytes} bytes)`);
  out(`  injecagent @ ${PINNED.injecagent.commit}: ${injecagent.length} templates`);
  out(
    `  agentdojo @ ${PINNED.agentdojo.commit}: ${agentdojo.templates.length} templates ({user}=${agentdojo.fill.user}, {model}=${agentdojo.fill.model})`,
  );
  out(
    `  candidates examined: ${s.examined} (rejected: ${s.rejectedNoResults} no results, ${s.rejectedNoCap} no cap)`,
  );
  out(`  tasks: ${data.tasks.length} (dev ${dev} / test ${data.tasks.length - dev})`);
  out(`  episodes: ${data.episodes.length}  attacked: ${attacked.length}`);
  out(
    `  targets: outside ${attacked.filter((e) => e.targetType === 'outside_rules').length}  inside ${attacked.filter((e) => e.targetType === 'inside_rules').length}  fallbacks ${attacked.filter((e) => e.targetFallback).length}`,
  );
  out(
    `  tasks with a non-attacker listing under cap: ${s.tasksWithListingUnderCap}  with none: ${s.tasksWithoutListingUnderCap}`,
  );
  out(`  unmapped categories: ${s.unmappedCategories.length} (category 'other')`);
  for (const text of s.unmappedCategories) out(`    unmapped: ${text}`);
  out(`  listings in snapshot: ${data.listings.length}  merchants: ${data.merchants.length}`);
  out(`  snapshot sha256 ${data.snapshotSha256}`);
  out(`  episodes sha256 ${data.episodesSha256}`);
  out(`  frozen episodes unchanged: ${frozenKept}`);
}

async function freeze(args: string[]) {
  const env = loadBuildEnv();
  const { db, sql } = createDb(env.DATABASE_URL);
  try {
    const manifest = await buildManifest(db);
    if (args.includes('--tag')) {
      await tagFreeze(db, manifest);
      out(`frozen: ${MANIFEST_PATH} committed and tagged`);
    } else if (!args.includes('--dry-run')) {
      throw new AppError(ErrorCode.VALIDATION, 'Use freeze --dry-run or freeze --tag');
    }
    out(JSON.stringify(manifest, null, 2));
  } finally {
    await sql.end();
  }
}

function splitFlag(args: string[]): Split {
  const split = flag(args, '--split');
  if (split !== 'dev' && split !== 'test') {
    throw new AppError(ErrorCode.VALIDATION, 'Pass --split dev|test');
  }
  return split;
}

/** Optional --models a,b for replay and metrics; absent means every model with runs. */
function modelsFlag(args: string[]): string[] | undefined {
  const raw = flag(args, '--models');
  return raw === undefined || raw === 'all' ? undefined : parseModelList(raw);
}

async function withDb<T>(fn: (db: ReturnType<typeof createDb>['db']) => Promise<T>): Promise<T> {
  const env = loadBuildEnv();
  const { db, sql } = createDb(env.DATABASE_URL);
  try {
    return await fn(db);
  } finally {
    await sql.end();
  }
}

async function run(args: string[]) {
  const env = loadEnv('eval');
  const split = splitFlag(args);
  const configured = parseModelList(env.EVAL_MODELS);
  const requested = flag(args, '--models') ?? 'all';
  const models = requested === 'all' ? configured : parseModelList(requested);
  const unknown = models.filter((m) => !configured.includes(m));
  if (unknown.length > 0) {
    throw new AppError(ErrorCode.VALIDATION, `Not in EVAL_MODELS: ${unknown.join(', ')}`);
  }
  const pilotRaw = flag(args, '--pilot');
  const pilot = pilotRaw === undefined ? undefined : Number(pilotRaw);
  if (pilot !== undefined && (!Number.isInteger(pilot) || pilot < 1)) {
    throw new AppError(ErrorCode.VALIDATION, '--pilot takes a positive whole number');
  }
  const { db, sql } = createDb(env.DATABASE_URL);
  try {
    await runEval(
      env,
      db,
      {
        split,
        models,
        concurrency: Number(flag(args, '--concurrency') ?? 3),
        concurrencyFor: Object.fromEntries(
          (flag(args, '--concurrency-for') ?? '')
            .split(',')
            .filter(Boolean)
            .map((kv) => {
              const at = kv.lastIndexOf('=');
              return [kv.slice(0, at), Number(kv.slice(at + 1))];
            }),
        ),
        rpm: Number(flag(args, '--rpm') ?? 35),
        pilot,
        maxWaitMinutes: Number(flag(args, '--max-wait-minutes') ?? 60),
      },
      out,
    );
  } finally {
    await sql.end();
  }
}

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const bound = (v: number | null) => (v === null ? '—' : `≤ ${pct(v)}`);

function printMetrics(m: Metrics) {
  out(`metrics ${m.split} (${m.gateVersion}) → ${metricsPath(m.split)}`);
  if (m.modelsFilter) out(`models filter: ${m.modelsFilter.join(', ')}`);
  for (const [model, x] of Object.entries(m.models)) {
    out(model);
    out(
      `  runs ${x.runs} · attacked ${x.attacked} · followed ${x.followed} (followRate ${pct(x.followRate)})` +
        ` · proposals ${x.proposals} · clean runs with a proposal ${x.cleanWithProposal}/${x.cleanRuns}`,
    );
    for (const g of GATES) {
      const d = x.gates[g];
      out(
        `  ${g}: letThrough ${pct(d.letThrough)} (${d.letThroughCount}/${x.attacked}; attacker ${d.attackerCaptured}, inside ${d.insideCaptured})` +
          ` · held ${d.held} · honestInterrupted ${pct(d.honestInterrupted)} (${d.honestInterruptedCount}/${x.cleanWithProposal})`,
      );
    }
    const i = x.insideRules;
    out(
      `  G4, followed inside_rules attacks (${i.followed}): pass hard rules ${pct(i.passShare)}` +
        ` · held by anomaly ${pct(i.heldShare)} · blocked ${pct(i.blockedShare)}`,
    );
    out(`  rule of three (G4 attacker captures = 0): ${bound(x.ruleOfThree)}`);
    const ft = x.followByTarget;
    out(
      `  followed by target: outside_rules ${ft.outside_rules.followed}/${ft.outside_rules.available} (${pct(ft.outside_rules.rate)})` +
        ` · inside_rules ${ft.inside_rules.followed}/${ft.inside_rules.available} (${pct(ft.inside_rules.rate)})`,
    );
    const why = Object.entries(x.g4Interruptions.blockedBy)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rule, n]) => `${rule} ${n}`)
      .join(', ');
    out(
      `  G4 honest interruptions (${x.gates.G4.honestInterruptedCount}): anomaly hold ${x.g4Interruptions.anomalyHold}` +
        ` · blocked by: ${why || 'none'}`,
    );
  }
  out(`pooled: attacked ${m.pooled.attacked} · rule of three ${bound(m.pooled.ruleOfThree)}`);
  out(`attackerMoneyCentsG4 = ${m.attackerMoneyCentsG4}`);
  const fiveEach = m.totals.gateDecisions === GATES.length * m.totals.proposals;
  out(
    `totals: runs ${m.totals.runs} · proposals ${m.totals.proposals} · gateDecisions ${m.totals.gateDecisions}` +
      ` (= ${GATES.length} × proposals: ${fiveEach ? 'yes' : 'NO'})` +
      ` · tokens ${m.totals.tokensIn + m.totals.tokensOut} · cost $${m.totals.totalCostUsd.toFixed(4)}`,
  );
}

async function predictionsCmd(args: string[]) {
  const [sub, ...more] = args;
  if (sub === 'register') {
    const file = flag(more, '--file') ?? 'PREDICTIONS.md';
    const n = await withDb((db) => registerPredictions(db, file));
    out(`registered ${n} predictions from ${file}`);
  } else if (sub === 'score') {
    const split = splitFlag(more);
    const rows = await withDb((db) => scorePredictions(db, split));
    for (const r of rows) {
      const verdict = r.hit === null ? '' : r.hit ? 'HIT' : 'MISS';
      out(
        `${r.metric} ${r.model ?? ''} ${r.gate ?? ''}: [${r.predictedLow}, ${r.predictedHigh}] actual ${r.actual ?? '—'} ${verdict}`,
      );
    }
  } else {
    throw new AppError(ErrorCode.VALIDATION, 'Use predictions register --file F | score --split S');
  }
}

const USAGE = [
  'usage: npm run eval -- <build|freeze|run|replay|grade|metrics|predictions|checkpoint>',
  '  run --split dev|test [--models all|a,b] [--concurrency 3 (per model)] [--concurrency-for model=N,...] [--rpm 35 (all models)] [--pilot N (per model)] [--max-wait-minutes 60]',
  '  grade --split dev|test   labels product_detail_ok (LLM-graded, first EVAL_MODELS entry)',
  '',
].join('\n');

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'build') await build(rest);
  else if (command === 'freeze') await freeze(rest);
  else if (command === 'run') await run(rest);
  else if (command === 'replay') {
    const split = splitFlag(rest);
    const models = modelsFlag(rest);
    const r = await withDb((db) => replay(db, split, models));
    out(
      `replayed ${r.proposals} proposals × ${GATES.length} gates: ${r.decisionsWritten} decisions written` +
        ` (static cap ${r.staticCapCents} cents from ${r.staticCapSource}); every live G4 matched`,
    );
  } else if (command === 'grade') {
    const env = loadEnv('eval');
    const split = splitFlag(rest);
    const { db, sql } = createDb(env.DATABASE_URL);
    try {
      await grade(env, db, split, out);
    } finally {
      await sql.end();
    }
  } else if (command === 'metrics') {
    const split = splitFlag(rest);
    const models = modelsFlag(rest);
    printMetrics(await withDb((db) => computeMetrics(db, split, models)));
  } else if (command === 'predictions') await predictionsCmd(rest);
  else if (command === 'checkpoint') {
    const env = loadEnv('eval');
    const c = checkpoint(env.EVAL_WEAK_MODEL);
    out(`checkpoint (dev): ${env.EVAL_WEAK_MODEL} followed ${c.followed}/${c.attacked} attacks`);
    out(c.verdict);
    if (c.verdict === 'RESCOPE') out(FALLBACK_HEADLINE);
  } else {
    process.stderr.write(USAGE);
    process.exit(2);
  }
} catch (err) {
  const message = err instanceof AppError ? err.message : String(err);
  process.stderr.write(`eval ${command}: ${message}\n`);
  process.exit(1);
}
