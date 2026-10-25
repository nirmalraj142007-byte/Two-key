import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { GUARDRAIL_SHA256 } from '@twokey/agent-runner/system-prompt';
import { AppError, ErrorCode } from '@twokey/core';
import { attackTemplates, catalogSnapshots, type Db, evalEpisodes, evalTasks } from '@twokey/db';
import { eq, inArray } from 'drizzle-orm';
import { AGENTDOJO_BENCHMARK, PINNED } from './attacks.js';
import { episodesDigest } from './dataset.js';
import { SNAPSHOT_ID } from './persist.js';
import { sha256 } from './util.js';
import { WEBSHOP_FILE } from './webshop.js';

export const FREEZE_TAG = 'eval-freeze-2026-10-27';
export const MANIFEST_PATH = 'eval/frozen/manifest.json';

/**
 * 75th percentile of the test-task caps (linear interpolation between closest ranks), rounded to
 * the nearest $5.
 */
export function staticCapCents(capsCents: readonly number[]): number {
  if (capsCents.length === 0) throw new AppError(ErrorCode.VALIDATION, 'No test-task caps');
  const sorted = [...capsCents].sort((a, b) => a - b);
  const rank = 0.75 * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const p75 =
    (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (rank - lo);
  return Math.round(p75 / 500) * 500;
}

export interface Manifest {
  counts: { tasks: { dev: number; test: number }; episodes: number; attacked: number };
  staticCapCents: number;
  guardrailSha256: string;
  episodeHashes: string;
  snapshotSha256: string | null;
  sources: {
    webshop: { file: string; sha256: string | null; bytes: number | null };
    injecagent: { repo: string; commit: string; templates: number };
    agentdojo: { repo: string; commit: string; benchmark: string; templates: number };
  };
}

export async function buildManifest(db: Db): Promise<Manifest> {
  const tasks = await db
    .select({ split: evalTasks.split, cap: evalTasks.priceCapCents })
    .from(evalTasks);
  const episodes = await db
    .select({ variant: evalEpisodes.variant, sha: evalEpisodes.contentSha256 })
    .from(evalEpisodes);
  const templates = await db.select({ source: attackTemplates.source }).from(attackTemplates);
  const [snapshot] = await db
    .select({ sha: catalogSnapshots.contentSha256 })
    .from(catalogSnapshots)
    .where(eq(catalogSnapshots.id, SNAPSHOT_ID));
  if (tasks.length === 0) {
    throw new AppError(ErrorCode.CONFIG_INVALID, 'No evaluation tasks. Run: npm run eval -- build');
  }
  const webshop = existsSync(WEBSHOP_FILE) ? readFileSync(WEBSHOP_FILE) : null;
  return {
    counts: {
      tasks: {
        dev: tasks.filter((t) => t.split === 'dev').length,
        test: tasks.filter((t) => t.split === 'test').length,
      },
      episodes: episodes.length,
      attacked: episodes.filter((e) => e.variant !== 'clean').length,
    },
    staticCapCents: staticCapCents(tasks.filter((t) => t.split === 'test').map((t) => t.cap)),
    guardrailSha256: GUARDRAIL_SHA256,
    episodeHashes: episodesDigest(episodes.map((e) => e.sha)),
    snapshotSha256: snapshot?.sha ?? null,
    sources: {
      webshop: {
        file: WEBSHOP_FILE,
        sha256: webshop ? sha256(webshop) : null,
        bytes: webshop?.length ?? null,
      },
      injecagent: {
        repo: PINNED.injecagent.repo,
        commit: PINNED.injecagent.commit,
        templates: templates.filter((t) => t.source === 'injecagent').length,
      },
      agentdojo: {
        repo: PINNED.agentdojo.repo,
        commit: PINNED.agentdojo.commit,
        benchmark: AGENTDOJO_BENCHMARK,
        templates: templates.filter((t) => t.source === 'agentdojo').length,
      },
    },
  };
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** Marks the test episodes frozen, commits the manifest and creates the freeze tag. */
export async function tagFreeze(db: Db, manifest: Manifest): Promise<void> {
  if (git(['tag', '--list', FREEZE_TAG])) {
    throw new AppError(ErrorCode.CONFLICT, `Tag ${FREEZE_TAG} already exists`);
  }
  const testTasks = await db
    .select({ id: evalTasks.id })
    .from(evalTasks)
    .where(eq(evalTasks.split, 'test'));
  await db
    .update(evalEpisodes)
    .set({ frozenTag: FREEZE_TAG })
    .where(
      inArray(
        evalEpisodes.taskId,
        testTasks.map((t) => t.id),
      ),
    );
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  git(['add', MANIFEST_PATH]);
  git(['commit', '-m', `eval freeze ${FREEZE_TAG.slice(-10)}`, '--', MANIFEST_PATH]);
  git([
    'tag',
    '-a',
    FREEZE_TAG,
    '-m',
    `Evaluation freeze. GUARDRAIL_SHA256=${manifest.guardrailSha256} episodeHashes=${manifest.episodeHashes}`,
  ]);
}
