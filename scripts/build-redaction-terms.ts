/**
 * Builds the committed redaction data every environment uses (W17), so Render redacts exactly
 * like a machine that has the git-ignored Channel3 cache and vendor checkouts:
 *
 *   apps/web/data/redaction-terms.json   brand names (eval snapshot + Channel3 cache) and
 *                                        third-party service names; PayPal is never a term
 *   apps/web/data/template-sources.json  for each attack template, the source files and the
 *                                        exact lines at the pinned commit
 *
 * Store domains are NOT written here: they stay in the database, and the web app numbers them
 * ("Store 007") from the merchants table at runtime.
 *
 *   npx tsx scripts/build-redaction-terms.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { attackTemplates, createDb } from '@twokey/db';
import { loadBrandNames } from '../apps/web/lib/brand-names';
import { parseSourceRef } from '../apps/web/lib/episodes-view';

/**
 * Payment and finance services named in published attack templates, or likely to be. Names that
 * are ordinary English words (Square, Wise, Stripe, Cash) are left out: redacting them would
 * mangle task text.
 */
export const SERVICE_NAMES = [
  'Venmo',
  'Binance',
  'Coinbase',
  'Zelle',
  'Cash App',
  'CashApp',
  'Revolut',
  'Robinhood',
  'Western Union',
  'MoneyGram',
  'Apple Pay',
  'Google Pay',
  'Alipay',
  'WeChat Pay',
  'Payoneer',
  'Skrill',
  'Kraken',
  'Gemini',
  'Etherscan',
  'MetaMask',
];

/** Never redacted: Two-Key's own payment provider. */
const KEEP = new Set(['paypal']);

const VENDOR: Record<string, string> = {
  injecagent: 'eval/vendor/InjecAgent',
  agentdojo: 'eval/vendor/agentdojo',
};

export interface SourceLine {
  file: string;
  caseId: string | null;
  line: number | null;
  url: string | null;
}

/** The line a case starts at: "line 30 (…)" as given; a Python class at its GOAL / _JB_STRING. */
export function findLine(
  source: string,
  caseId: string | null,
  text: string | null,
): number | null {
  if (!caseId) return null;
  const given = /^line (\d+)/.exec(caseId)?.[1];
  if (given) return Number(given);
  if (!text) return null;
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^class ${caseId}\\b`).test(l));
  if (start < 0) return null;
  const field =
    source === 'agentdojo' && caseId.startsWith('InjectionTask') ? 'GOAL' : '_JB_STRING';
  for (let i = start + 1; i < lines.length; i++) {
    if (/^class /.test(lines[i] ?? '')) break;
    if (new RegExp(`^\\s+${field}\\b`).test(lines[i] ?? '')) return i + 1;
  }
  return start + 1;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const { db, sql } = createDb(url);
  try {
    const brands = (await loadBrandNames(db)).filter((b) => !KEEP.has(b.toLowerCase()));
    const terms = { brands, services: SERVICE_NAMES };
    writeFileSync('apps/web/data/redaction-terms.json', `${JSON.stringify(terms, null, 2)}\n`);
    console.log(`redaction terms: ${brands.length} brands, ${SERVICE_NAMES.length} services`);

    const templates = await db
      .select({ source: attackTemplates.source, sourceRef: attackTemplates.sourceRef })
      .from(attackTemplates);
    const out: Record<string, SourceLine[]> = {};
    for (const t of templates) {
      const ref = parseSourceRef(t.source, t.sourceRef);
      out[t.sourceRef] = ref.files.map((f) => {
        const path = `${VENDOR[t.source] ?? ''}/${f.file}`;
        const text = existsSync(path) ? readFileSync(path, 'utf8') : null;
        const line = findLine(t.source, f.caseId, text);
        if (line === null) throw new Error(`no line for ${t.sourceRef} (${f.file})`);
        return {
          file: f.file,
          caseId: f.caseId,
          line,
          url: f.url ? `${f.url.split('#')[0]}#L${line}` : null,
        };
      });
    }
    writeFileSync('apps/web/data/template-sources.json', `${JSON.stringify(out, null, 2)}\n`);
    console.log(`template sources: ${templates.length} templates`);
  } finally {
    await sql.end();
  }
}

for (const file of ['.env.web', '.env.gateway']) {
  if (!process.env.DATABASE_URL && existsSync(file)) process.loadEnvFile(file);
}
await main();
