/**
 * W17 check: fetch the rendered HTML of random public episode pages (and the episodes API) and
 * look for every brand name in the evaluation snapshot. Exits 1 if any is found.
 *
 *   npx tsx scripts/check-redaction.ts [--base http://localhost:3000] [--pages 20]
 *
 * Reads DATABASE_URL from the environment, else .env.web / .env.gateway.
 */
import { existsSync } from 'node:fs';
import { createDb, evalEpisodes, evalRuns } from '@twokey/db';
import { sql } from 'drizzle-orm';
import { loadBrandNames } from '../apps/web/lib/brand-names';
import { findBrands } from '../apps/web/lib/redact';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

for (const file of ['.env.web', '.env.gateway']) {
  if (!process.env.DATABASE_URL && existsSync(file)) process.loadEnvFile(file);
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1]?.toLowerCase() === 'x' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * What a reader sees: text nodes plus the attributes that render as text (title, alt,
 * aria-label, placeholder, meta content). Class names and script payloads are code, not copy.
 */
export function visibleText(html: string): string {
  const attrs = [
    ...html.matchAll(/\s(?:title|alt|aria-label|placeholder|content)="([^"]*)"/gi),
  ].map((m) => m[1] ?? '');
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decode(`${body}\n${attrs.join('\n')}`);
}

/** Every string in a JSON value, except model IDs (provider/model, not listing data). */
function jsonStrings(value: unknown, key = ''): string[] {
  if (typeof value === 'string') return key === 'model' ? [] : [value];
  if (Array.isArray(value)) return value.flatMap((v) => jsonStrings(v));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => jsonStrings(v, k));
  }
  return [];
}

async function main() {
  const base = arg('base', 'http://localhost:3000').replace(/\/$/, '');
  const pages = Number(arg('pages', '20'));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (and no .env.web or .env.gateway)');
  const { db, sql: client } = createDb(url);
  try {
    const brands = await loadBrandNames(db);
    // Episodes that at least one model has run, in random order.
    const rows = await db
      .selectDistinct({ id: evalEpisodes.id, r: sql<number>`random()` })
      .from(evalEpisodes)
      .innerJoin(evalRuns, sql`${evalRuns.episodeId} = ${evalEpisodes.id}`)
      .orderBy(sql`2`)
      .limit(pages);
    console.log(`brand names in the snapshot: ${brands.length}`);

    const found: { where: string; brand: string; context: string }[] = [];
    const scan = (where: string, text: string) => {
      for (const brand of new Set(findBrands(text, brands).map((b) => b.toLowerCase()))) {
        const i = text.toLowerCase().indexOf(brand.toLowerCase());
        const context = text.slice(Math.max(0, i - 40), i + brand.length + 40).replace(/\s+/g, ' ');
        found.push({ where, brand, context });
      }
    };

    let checked = 0;
    for (const { id } of rows) {
      const res = await fetch(`${base}/results/episodes/${id}`);
      const html = await res.text();
      if (res.status !== 200) throw new Error(`/results/episodes/${id} returned ${res.status}`);
      if (!html.includes('data-slot="gate-row"') && !html.includes('No proposal')) {
        throw new Error(`/results/episodes/${id} rendered without its runs (still streaming?)`);
      }
      scan(`/results/episodes/${id}`, visibleText(html));
      checked++;
    }

    // The other public results pages (their grid rows arrive through the API, scanned below).
    for (const path of ['/results', '/results/episodes', '/results/episodes?split=test']) {
      const res = await fetch(`${base}${path}`);
      if (res.status !== 200) throw new Error(`${path} returned ${res.status}`);
      scan(path, visibleText(await res.text()));
    }

    let apiRows = 0;
    for (const split of ['dev', 'test']) {
      for (let page = 1; ; page++) {
        const res = await fetch(`${base}/api/results/episodes?split=${split}&page=${page}`);
        if (res.status !== 200) throw new Error(`episodes API (${split}) returned ${res.status}`);
        const body = (await res.json()) as { rows: unknown[]; pages: number };
        apiRows += body.rows.length;
        scan(`/api/results/episodes?split=${split}&page=${page}`, jsonStrings(body).join('\n'));
        if (page >= body.pages) break;
      }
    }

    for (const f of found) console.log(`FOUND "${f.brand}" in ${f.where}: …${f.context}…`);
    console.log(`episodes API: ${apiRows} rows scanned`);
    console.log(`checked ${checked} pages · ${found.length} brand names found`);
    if (checked < pages) throw new Error(`only ${checked} episode pages were available`);
    if (found.length > 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

await main();
