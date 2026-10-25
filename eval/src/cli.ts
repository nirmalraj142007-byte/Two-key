/**
 * Evaluation CLI. `npm run eval -- build` builds the frozen set; `freeze [--dry-run|--tag]`
 * writes the manifest. Env comes from .env.eval (DATABASE_URL, CHANNEL3_API_KEY).
 */
import { AppError, ErrorCode, SECRET_OWNERS } from '@twokey/core';
import { createDb } from '@twokey/db';
import { z } from 'zod';
import { loadAgentDojo, loadInjecAgent, PINNED } from './attacks.js';
import { CACHE_DIR, Channel3Cache, sdkFetch } from './channel3.js';
import { buildDataset } from './dataset.js';
import { buildManifest, MANIFEST_PATH, tagFreeze } from './freeze.js';
import { persistDataset } from './persist.js';
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

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'build') await build(rest);
  else if (command === 'freeze') await freeze(rest);
  else {
    process.stderr.write('usage: npm run eval -- <build|freeze> [--dry-run|--tag]\n');
    process.exit(2);
  }
} catch (err) {
  const message = err instanceof AppError ? err.message : String(err);
  process.stderr.write(`eval ${command}: ${message}\n`);
  process.exit(1);
}
