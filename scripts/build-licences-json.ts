/**
 * DATA_LICENCES.md → apps/web/public/licences.json, the sources list in the /results footer.
 * Runs before every web build (`npm run build -w @twokey/web`); `--check` fails when the
 * committed JSON is out of date.
 *
 *   npx tsx scripts/build-licences-json.ts [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface LicenceSource {
  name: string;
  /** Upstream repository or terms page. */
  url: string | null;
  licence: string;
  commit: string | null;
  commitUrl: string | null;
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = `${ROOT}DATA_LICENCES.md`;
const OUT = `${ROOT}apps/web/public/licences.json`;

export function parseLicences(md: string): LicenceSource[] {
  const sections = md.split(/^## /m).slice(1);
  return sections.map((section) => {
    const [heading = '', ...rest] = section.split('\n');
    const body = rest.join('\n');
    const name = heading.split(' — ')[0]?.trim() ?? heading.trim();
    const url =
      /\]\((https?:\/\/[^)\s]+)\)/.exec(body)?.[1] ??
      /<(https?:\/\/[^>\s]+)>/.exec(body)?.[1] ??
      null;
    const licence =
      /\*\*([^*]*\b(?:MIT|Apache|BSD|GPL|CC[- ]BY)\b[^*]*)\*\*/.exec(body)?.[1]?.trim() ??
      (/\*\*Terms:\*\*/.test(body) ? 'Terms of service (no republishing licence)' : 'Unknown');
    const commit = /`([0-9a-f]{40})`/.exec(body)?.[1] ?? null;
    const github = url && /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(url) ? url : null;
    return {
      name,
      url,
      licence,
      commit,
      commitUrl: github && commit ? `${github}/commit/${commit}` : null,
    };
  });
}

function main() {
  const json = `${JSON.stringify({ sources: parseLicences(readFileSync(SOURCE, 'utf8')) }, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUT, 'utf8');
    if (current !== json) {
      console.error(
        'apps/web/public/licences.json is out of date: run npx tsx scripts/build-licences-json.ts',
      );
      process.exit(1);
    }
    console.log('licences.json is up to date');
    return;
  }
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
