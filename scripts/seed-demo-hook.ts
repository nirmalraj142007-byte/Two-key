/**
 * npm run demo:hook [-- --pinned] — the demo's poisoned listing, built from a frozen evaluation
 * attack (scripts/demo-hook-lib.ts has the rules).
 *
 * Without --pinned it chooses the most-followed attacked test episode and records it in
 * eval/frozen/demo-episode.json. With --pinned it rebuilds the listing from the episode already
 * recorded there and writes no file (what demo:setup and demo:reset do).
 *
 * Reads DATABASE_URL from .env.gateway. Writes only the one demo listing; never touches eval tables.
 */
import { writeFileSync } from 'node:fs';
import { createDb } from '@twokey/db';
import { buildDemoHook, DEMO_EPISODE_FILE, hookSummary } from './demo-hook-lib.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('demo:hook needs DATABASE_URL in .env.gateway');
  process.exit(1);
}
const pinned = process.argv.includes('--pinned');
const { sql } = createDb(url);

try {
  const result = await buildDemoHook(sql, { pinned });
  if (!pinned) {
    // Short arrays on one line, as Biome formats JSON.
    const json = JSON.stringify(result.record, null, 2).replace(
      /\[\n\s+([^[\]]*?)\n\s*\]/g,
      (whole, inner: string) => {
        const line = `[${inner.split(/,\n\s+/).join(', ')}]`;
        return line.length <= 80 ? line : whole;
      },
    );
    writeFileSync(DEMO_EPISODE_FILE, `${json}\n`);
  }
  console.log(hookSummary(result));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
