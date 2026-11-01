/**
 * Reads apps/web/.next/diagnostics/route-bundle-stats.json after `npm run build -w @twokey/web`
 * and prints, per route, the gzipped first-load JS, plus the chunks every route shares and which
 * routes load AG Grid / AG Charts code:
 *
 *   node scripts/bundle-report.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const web = fileURLToPath(new URL('../apps/web/', import.meta.url));
const stats = JSON.parse(
  readFileSync(join(web, '.next/diagnostics/route-bundle-stats.json'), 'utf8'),
);
const slashes = (p) => p.split(String.fromCharCode(92)).join('/');
const cache = new Map();
function chunk(path) {
  const file = slashes(path);
  if (!cache.has(file)) {
    const buf = readFileSync(join(web, file));
    cache.set(file, {
      gzip: gzipSync(buf).length,
      ag: /ag-grid|AgGrid|ag-charts|AgCharts|agChart/i.test(buf.toString('utf8')),
    });
  }
  return cache.get(file);
}
const rows = stats.map((r) => {
  const paths = r.firstLoadChunkPaths.map(slashes);
  return {
    route: r.route,
    kb: paths.reduce((n, p) => n + chunk(p).gzip, 0) / 1024,
    ag: paths.some((p) => chunk(p).ag),
    paths: new Set(paths),
  };
});
const shared = new Set([...rows[0].paths].filter((p) => rows.every((r) => r.paths.has(p))));
const sharedKb = [...shared].reduce((n, p) => n + chunk(p).gzip, 0) / 1024;
console.log(`shared by every route: ${shared.size} chunks, ${sharedKb.toFixed(1)} KB gzip`);
for (const r of rows.sort((a, b) => b.kb - a.kb)) {
  const flag = r.ag ? '   [AG Grid/Charts]' : '';
  console.log(`${r.route.padEnd(34)} ${r.kb.toFixed(1).padStart(7)} KB gzip first-load${flag}`);
}
