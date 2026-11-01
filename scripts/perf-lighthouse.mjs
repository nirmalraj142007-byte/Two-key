/**
 * Lighthouse (mobile, simulated throttling, performance only) against a PRODUCTION build served
 * on :3000, 3 runs per page, median reported:
 *
 *   node scripts/perf-lighthouse.mjs [path ...]      default: / and /m/approve/<latest approval>
 *
 * Pages behind sign-in get a session cookie minted here from AUTH_SECRET (.env.web) for the
 * approval's owner, the same JWT Auth.js issues at sign-in. Set CHROME_PATH to a Chromium
 * browser (Edge works: C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe).
 * Needs DATABASE_URL in .env.gateway (local) to find the approval.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { encode } from '@auth/core/jwt';
import postgres from 'postgres';

const root = new URL('../', import.meta.url);
const read = (name) => parseEnv(readFileSync(new URL(name, root), 'utf8'));
const base = process.env.WEB_URL ?? 'http://127.0.0.1:3000';
const RUNS = 3;

let paths = process.argv.slice(2);
let cookie;
if (paths.length === 0) {
  const sql = postgres(read('.env.gateway').DATABASE_URL);
  const [row] =
    await sql`select a.id, a.user_id, u.role from approvals a join users u on u.id = a.user_id order by a.deadline_at desc limit 1`;
  await sql.end();
  if (!row) throw new Error('no approval in the database: run npm run demo:hook or the e2e first');
  const salt = 'authjs.session-token';
  const token = await encode({
    token: { userId: row.user_id, role: row.role, sub: row.user_id },
    secret: read('.env.web').AUTH_SECRET,
    salt,
    maxAge: 3600,
  });
  cookie = `${salt}=${token}`;
  paths = ['/', `/m/approve/${row.id}`];
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const dir = mkdtempSync(join(tmpdir(), 'lh-'));
const PORT = 9333;
const browser = spawn(
  process.env.CHROME_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(dir, 'profile')}`,
    '--no-first-run',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
await new Promise((resolve) => setTimeout(resolve, 3000));
for (const path of paths) {
  const scores = [];
  const last = {};
  for (let i = 0; i < RUNS; i++) {
    const out = join(dir, `run-${i}.json`);
    const args = [
      'lighthouse',
      `${base}${path}`,
      '--preset=perf',
      '--form-factor=mobile',
      '--output=json',
      `--output-path=${out}`,
      '--quiet',
      `--port=${PORT}`,
    ];
    if (cookie && path !== '/') {
      const headers = join(dir, 'headers.json');
      writeFileSync(headers, JSON.stringify({ Cookie: cookie }));
      args.push(`--extra-headers=${headers}`);
    }
    const run = spawnSync('npx', args, { stdio: 'inherit', shell: true, env: process.env });
    if (run.status !== 0) throw new Error(`lighthouse failed for ${path}`);
    const lhr = JSON.parse(readFileSync(out, 'utf8'));
    if (lhr.finalDisplayedUrl && new URL(lhr.finalDisplayedUrl).pathname !== path.split('?')[0]) {
      throw new Error(`${path} redirected to ${lhr.finalDisplayedUrl} (signed out?)`);
    }
    scores.push(Math.round(lhr.categories.performance.score * 100));
    for (const k of [
      'first-contentful-paint',
      'largest-contentful-paint',
      'total-blocking-time',
      'cumulative-layout-shift',
      'speed-index',
    ]) {
      last[k] = [...(last[k] ?? []), lhr.audits[k].numericValue];
    }
  }
  const metrics = Object.fromEntries(
    Object.entries(last).map(([k, v]) => [k, Math.round(median(v) * 1000) / 1000]),
  );
  console.log(
    JSON.stringify({
      path: path.replace(/[0-9a-f-]{36}/, '<approval-id>'),
      scores,
      median: median(scores),
      metrics,
    }),
  );
}
browser.kill();
