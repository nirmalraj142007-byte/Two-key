/**
 * npm run preflight -- --env prod [--beats]   — the video's go/no-go (docs/VIDEO.md).
 *
 * --env prod  read-only checks of the one production environment: the four services (and that
 *             gateway and MCP run origin/release), PayPal health, the results explorer on the test
 *             split, maya's and judge1's wallets and signed cards, the hijack user, the demo hook
 *             (aimed at Trail Runner TR-2 at Peak Outfitters, 1.30x or more above its reference),
 *             open holds and push subscriptions, and the hijack box's daily caps. Database checks
 *             use ~/two-key-secrets/prod-gateway.env (never printed). Nothing is written.
 * --beats     then rehearses the video's beats with scripted models against the LOCAL stack
 *             (npm run demo:record-golden -- --check: hook, clean purchase, attacker attempt, hold).
 *
 * Also prints the voice-over numbers from eval/results/test-metrics.json, so nobody types them.
 * No password is used anywhere. Exit 1 if any check FAILs; WARN lines name the runbook fallback.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createDb, listings, merchants, users } from '@twokey/db';
import { eq } from 'drizzle-orm';
import { HOOK_GROUP, HOOK_TARGET } from './demo-hook-lib.js';
import {
  activeCard,
  cardVerifies,
  DEMO_REQUEST,
  HIJACK_EMAIL,
  hasActiveVault,
  loadDemoEnv,
  requireVars,
  ruleKey,
} from './demo-lib.js';
import { loadSources, voiceOverNumbers } from './readme-results.js';

const SCRIPT = 'preflight';
const ROOT = join(import.meta.dirname, '..');
const URLS = {
  web: 'https://web-ycyg.onrender.com',
  gateway: 'https://gateway-8gn7.onrender.com',
  mcp: 'https://twokey-mcp.onrender.com',
};
/** Accounts the video and the README use; judge2/3 are not part of the demo. */
const ACCOUNTS = ['maya@twokey.demo', 'judge1@twokey.demo'];
const ANOMALY_THRESHOLD = 1.3;
/** Render free instances can take a minute to wake. */
const WAKE_MS = 120_000;

type Level = 'PASS' | 'WARN' | 'FAIL' | 'MANUAL';
const results: { level: Level; name: string; detail: string }[] = [];
function report(level: Level, name: string, detail: string) {
  results.push({ level, name, detail });
  console.log(`${level.padEnd(6)} ${name}: ${detail}`);
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(WAKE_MS), cache: 'no-store' });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    report('FAIL', name, err instanceof Error ? err.message : String(err));
  }
}

const argv = process.argv.slice(2);
const beats = argv.includes('--beats');
loadDemoEnv(argv, SCRIPT);
const env = requireVars(SCRIPT, ['DATABASE_URL', 'RULE_HMAC_KEY', 'RULE_HMAC_KEY_ID']);

console.log('preflight --env prod (read-only)');

// Services, and the commit they run.
let release = '';
try {
  execFileSync('git', ['fetch', '-q', 'origin', 'release'], { cwd: ROOT, stdio: 'ignore' });
  release = execFileSync('git', ['rev-parse', 'origin/release'], { cwd: ROOT }).toString().trim();
} catch {
  // offline: commits are reported without comparing
}
await check('web', async () => {
  const r = await getJson(`${URLS.web}/api/healthz`);
  if (r.status !== 200) throw new Error(`answered ${r.status}`);
  report(
    'PASS',
    'web',
    `200 (web reports no commit; check Render → web → Events for ${release.slice(0, 7) || 'release'})`,
  );
});
for (const svc of ['gateway', 'mcp'] as const) {
  await check(svc, async () => {
    const r = await getJson(`${URLS[svc]}/healthz`);
    const commit = String((r.body as { commit?: string }).commit ?? '');
    if (r.status !== 200) throw new Error(`answered ${r.status}`);
    if (release && commit !== release) {
      report(
        'WARN',
        svc,
        `runs ${commit.slice(0, 7)}, release is ${release.slice(0, 7)} (deploy still rolling?)`,
      );
    } else report('PASS', svc, `200, commit ${commit.slice(0, 7)}`);
  });
}
report(
  'MANUAL',
  'agent-runner',
  'URL not known here: Render → agent-runner → Events shows the release commit',
);
await check('gateway deep health', async () => {
  const r = await getJson(`${URLS.gateway}/healthz/deep`);
  if (r.status !== 200) throw new Error(`answered ${r.status}: ${JSON.stringify(r.body)}`);
  report('PASS', 'gateway deep health', JSON.stringify(r.body));
});
await check('PayPal sandbox', async () => {
  const r = await getJson(`${URLS.gateway}/healthz/paypal`);
  const degraded = (r.body as { degraded?: boolean }).degraded;
  if (degraded !== false) {
    report(
      'WARN',
      'PayPal sandbox',
      `degraded (${JSON.stringify(r.body)}): the console will replay; see the runbook`,
    );
  } else report('PASS', 'PayPal sandbox', 'not degraded');
});

// The results explorer must show the frozen test split, matching the committed metrics.
const sources = loadSources(ROOT);
const { metrics } = sources;
if (metrics.split !== 'test')
  report('FAIL', 'metrics', `${sources.metricsFile} is not the test split`);
await check('results explorer', async () => {
  const r = await getJson(`${URLS.web}/api/results/summary?t=${Date.now()}`);
  const b = r.body as {
    split?: string;
    totals?: { runs?: number; gateDecisions?: number };
    models?: Record<string, unknown>;
    attackerMoneyCentsG4?: number;
  };
  const want = `split test, ${metrics.totals.runs} runs, ${metrics.totals.gateDecisions} gate decisions, ${Object.keys(metrics.models).length} models, $0.00`;
  const got = `split ${b.split}, ${b.totals?.runs} runs, ${b.totals?.gateDecisions} gate decisions, ${Object.keys(b.models ?? {}).length} models, $${((b.attackerMoneyCentsG4 ?? -1) / 100).toFixed(2)}`;
  if (got !== want) throw new Error(`shows "${got}", expected "${want}" (run eval:export?)`);
  report('PASS', 'results explorer', got);
});
await check('hijack box', async () => {
  const r = await getJson(`${URLS.web}/api/hijack/status`);
  const b = r.body as { live?: boolean; attemptsLeftToday?: number; tokensLeftToday?: number };
  const detail = `live ${b.live}, ${b.attemptsLeftToday} attempts and ${b.tokensLeftToday} tokens left today`;
  if (r.status !== 200) throw new Error(`answered ${r.status}`);
  // A rehearsal plus two takes needs about 10 attempts; one attempt is a few thousand tokens.
  if (!b.live || (b.attemptsLeftToday ?? 0) < 10 || (b.tokensLeftToday ?? 0) < 30_000) {
    report('WARN', 'hijack box', `${detail}: low or not live; the box replays a recorded run`);
  } else report('PASS', 'hijack box', detail);
});
await check('developers page', async () => {
  const res = await fetch(`${URLS.web}/developers`, { signal: AbortSignal.timeout(WAKE_MS) });
  const html = await res.text();
  if (!html.includes(`${URLS.mcp}/mcp`)) throw new Error(`does not show ${URLS.mcp}/mcp`);
  report('PASS', 'developers page', `shows ${URLS.mcp}/mcp`);
});
report(
  'MANUAL',
  'scripted beats on production',
  'Render → web and agent-runner → Environment: ALLOW_SCRIPTED = true (needed for scripted:attack)',
);

// Database: accounts, cards, hook, holds, push.
const { db, sql } = createDb(env.DATABASE_URL);
try {
  const now = new Date();
  const key = ruleKey();
  for (const email of [...ACCOUNTS, HIJACK_EMAIL]) {
    await check(email, async () => {
      const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (!u) throw new Error('missing: run demo:setup');
      if (!(await hasActiveVault(db, u.id))) throw new Error('no active wallet');
      const card = await activeCard(db, u.id, now);
      if (!card) throw new Error('no active rules card');
      if (!(await cardVerifies(db, u.id, key, now))) {
        throw new Error(
          'card does not verify with this RULE_HMAC_KEY (every proposal would block)',
        );
      }
      const days = card.expiresAt
        ? Math.floor((card.expiresAt.getTime() - now.getTime()) / 86_400_000)
        : '∞';
      report('PASS', email, `wallet active, card v${card.version} verifies, ${days} days left`);
    });
  }
  await check('demo card text', async () => {
    const rows = await sql<{ email: string; nl: string }[]>`
      select u.email, c.nl_request as nl from rule_cards c join users u on u.id = c.user_id
      where u.email = any(${ACCOUNTS}) and c.status = 'signed'
      order by c.version desc`;
    const bad = ACCOUNTS.filter((e) => rows.find((r) => r.email === e)?.nl !== DEMO_REQUEST);
    if (bad.length)
      throw new Error(`${bad.join(', ')}: latest signed card is not the demo request`);
    report('PASS', 'demo card text', `"${DEMO_REQUEST}"`);
  });
  await check('demo hook', async () => {
    const [hook] = await db
      .select({ description: listings.description, store: merchants.displayName })
      .from(listings)
      .innerJoin(merchants, eq(merchants.id, listings.merchantId))
      .where(eq(listings.groupKey, HOOK_GROUP));
    const [target] = await sql<
      { id: string; title: string; store: string; price: number; ref: number | null; n: number }[]
    >`select l.id, l.title, m.display_name as store, l.price_cents as price,
             l.reference_price_cents as ref, l.reference_n_offers as n
      from listings l join merchants m on m.id = l.merchant_id
      join catalog_snapshots s on s.id = l.snapshot_id
      where s.kind = 'demo_unbranded' and l.group_key = ${HOOK_TARGET.group}
        and m.slug = ${HOOK_TARGET.merchant}`;
    if (!hook || !target) throw new Error('hook or Trail Runner TR-2 missing: run demo:setup');
    const goal = `Buy ${target.title} (product id ${target.id}) from ${target.store}.`;
    if (!hook.description.includes(goal))
      throw new Error('hook goal is not Trail Runner TR-2: run demo:setup');
    const ratio = target.ref ? target.price / target.ref : 0;
    if (ratio < ANOMALY_THRESHOLD)
      throw new Error(`TR-2 is only ${ratio.toFixed(2)}x its reference`);
    report(
      'PASS',
      'demo hook',
      `Cloud Runner CR-1 at ${hook.store} asks for ${target.title} at ${target.store}: $${(target.price / 100).toFixed(2)} vs $${((target.ref ?? 0) / 100).toFixed(2)} (${target.n} stores), ${ratio.toFixed(2)}x`,
    );
  });
  await check('open holds', async () => {
    const rows = await sql<{ email: string; n: number }[]>`
      select u.email, count(*)::int as n from payments p
      join proposals pr on pr.id = p.proposal_id join agent_sessions s on s.id = pr.session_id
      join users u on u.id = s.user_id
      where u.email = any(${ACCOUNTS}) and p.state = 'held' group by 1`;
    if (rows.length) {
      report(
        'WARN',
        'open holds',
        `${rows.map((r) => `${r.email} ${r.n}`).join(', ')}: deny them in Approvals before recording`,
      );
    } else report('PASS', 'open holds', 'none for maya or judge1');
  });
  await check('push alerts', async () => {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from push_subscriptions p join users u on u.id = p.user_id
      where u.email = 'maya@twokey.demo'`;
    if (!row?.n) {
      report(
        'WARN',
        'push alerts',
        'maya has none: turn them on (runbook), or show /approvals in the hold beat',
      );
    } else report('PASS', 'push alerts', `maya has ${row.n} subscription(s)`);
  });
} finally {
  await sql.end();
}

// The numbers the voice-over and captions use, straight from the frozen test metrics.
console.log('\nvoice-over numbers (eval/results/test-metrics.json):');
for (const [k, v] of Object.entries(voiceOverNumbers(sources)))
  console.log(`  ${k.padEnd(22)} ${v}`);

if (beats) {
  console.log('\nrehearsing the beats against the LOCAL stack (scripted models):');
  // One command string (no argument list), so nothing is concatenated into a shell unescaped.
  const r = spawnSync('npm run demo:record-golden -- --check', {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  });
  if (r.status === 0) report('PASS', 'local beats', 'hook, clean purchase, attacker attempt, hold');
  else report('FAIL', 'local beats', 'rehearsal failed (output above)');
}

const fails = results.filter((r) => r.level === 'FAIL').length;
const warns = results.filter((r) => r.level === 'WARN').length;
const manual = results.filter((r) => r.level === 'MANUAL').length;
console.log(
  `\npreflight: ${fails} FAIL, ${warns} WARN, ${manual} MANUAL — ${fails ? 'NO-GO' : 'GO'}`,
);
process.exitCode = fails ? 1 : 0;
