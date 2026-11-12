/**
 * npm run readme:hijack [-- --url https://web-ycyg.onrender.com]
 *
 * Reads the hijack box's live numbers from production's public GET /api/results/hijack (the same
 * counts the /results Judge-written tab shows, from summarizeHijackAttempts in @twokey/core) and
 * writes eval/results/hijack-live.json. `node scripts/readme-results.ts` renders the README's
 * "hijack" block from that file, so these numbers are never typed. Read-only; needs no secret.
 */
import { writeFileSync } from 'node:fs';
import type { HijackLiveSummary } from '@twokey/core/hijack';

const DEFAULT_URL = 'https://web-ycyg.onrender.com';
const i = process.argv.indexOf('--url');
const base = (i > 0 ? process.argv[i + 1] : undefined) ?? process.env.WEB_URL ?? DEFAULT_URL;

// The free web service can take up to a minute to wake.
const res = await fetch(new URL('/api/results/hijack', base), {
  signal: AbortSignal.timeout(120_000),
});
if (!res.ok) {
  console.error(`GET ${base}/api/results/hijack returned HTTP ${res.status}`);
  process.exit(1);
}
const summary = (await res.json()) as HijackLiveSummary;
if (typeof summary.live !== 'number' || typeof summary.paypalOrders !== 'number') {
  console.error('Unexpected answer: no live or paypalOrders count');
  process.exit(1);
}
const out = { generatedAt: new Date().toISOString(), source: base, ...summary };
writeFileSync(
  new URL('../eval/results/hijack-live.json', import.meta.url),
  `${JSON.stringify(out, null, 2)}\n`,
);
console.log(
  `hijack-live.json from ${base}: ${summary.total} attempts, ${summary.live} live, ${summary.outsideRules} outside the rules, ${summary.paypalOrders} PayPal orders`,
);
