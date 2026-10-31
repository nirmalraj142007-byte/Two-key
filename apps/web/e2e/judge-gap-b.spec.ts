import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';

// Phase 26: judge-gap audit B (W13–W24), one test per row of docs/JUDGE_GAP_AUDIT.md that has a
// screen. Screenshots go to docs/evidence/Wnn-<slug>.png. Needs the dev stack (web :3000,
// gateway :4000), local Postgres and `npm run db:seed-users` (maya@twokey.demo). Read-only.

const root = join(__dirname, '..', '..', '..');
const OUT = join(root, 'docs', 'evidence');
const MAYA = 'maya@twokey.demo';
const AG_GRID_WARNING = 'NEXT_PUBLIC_AG_GRID_LICENSE_KEY is not set';

interface Summary {
  split: 'dev' | 'test';
  models: Record<
    string,
    {
      cleanWithProposal: number;
      followByTarget: Record<'outside_rules' | 'inside_rules', { available: number }>;
      gates: { G4: { honestInterrupted: number | null; honestInterruptedCount: number } };
    }
  >;
  totals: { runs: number; proposals: number; gateDecisions: number; totalCostUsd: number };
  headline: { attacked: number; attackerPayments: number };
}

let context: BrowserContext;
let page: Page;
let summary: Summary;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  const env = parseEnv(readFileSync(join(root, '.env.gateway'), 'utf8'));
  const password = process.env.DEMO_PASSWORD || env.DEMO_PASSWORD || '';
  if (!password) throw new Error('.env.gateway needs DEMO_PASSWORD');
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(MAYA);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.pathname !== '/login', { timeout: 60_000 });
  const res = await page.request.get('/api/results/summary');
  expect(res.ok()).toBe(true);
  summary = (await res.json()) as Summary;
});

test.afterAll(async () => {
  await context?.close();
});

async function settle(p: Page) {
  await p.waitForLoadState('load');
  await p.locator('main').first().waitFor({ state: 'visible', timeout: 30_000 });
  await p.waitForTimeout(1_500);
  await p.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

async function shot(p: Page, name: string, fullPage = true) {
  await p.screenshot({ path: join(OUT, `${name}.png`), fullPage });
}

const short = (id: string) => id.split('/').at(-1) ?? id;
const n = (x: number) => x.toLocaleString('en-US');

test('W13 inside the rules: per-model share, target split and fallback count', async () => {
  await page.goto('/results');
  await settle(page);
  await page.getByRole('tab', { name: 'Inside the rules' }).click();
  const sec = page.locator('section[aria-labelledby="inside-title"]');
  const models = Object.keys(summary.models);
  const share = sec.locator('table:has(caption:text("Followed inside-the-rules")) tbody tr');
  await expect(share).toHaveCount(models.length);
  // Every count links to its rows.
  for (let i = 0; i < models.length; i++) {
    const links = share.nth(i).locator('a[href^="/results/episodes?"]');
    await expect(links).toHaveCount(4);
  }
  const split = sec.locator('table[aria-labelledby="target-split-title"] tbody tr');
  await expect(split).toHaveCount(models.length);
  let fallbackHref = '';
  let fallbackCount = 0;
  for (const [i, id] of models.entries()) {
    const m = summary.models[id];
    if (!m) continue;
    const row = split.nth(i);
    await expect(row.locator('th')).toHaveText(short(id));
    const cells = row.locator('td a');
    await expect(cells.nth(0)).toHaveText(n(m.followByTarget.outside_rules.available));
    await expect(cells.nth(1)).toHaveText(n(m.followByTarget.inside_rules.available));
    const fb = Number(((await cells.nth(2).textContent()) ?? '').replace(/,/g, ''));
    if (fb > fallbackCount) {
      fallbackCount = fb;
      fallbackHref = (await cells.nth(2).getAttribute('href')) ?? '';
    }
  }
  test.info().annotations.push({ type: 'max fallback', description: String(fallbackCount) });
  await sec.locator('#target-split-title').scrollIntoViewIfNeeded();
  await shot(page, 'W13-inside-rules');
  // The fallback count opens exactly that many runs, each marked as a fallback.
  expect(fallbackHref).toContain('fallback=true');
  const p = await context.newPage();
  try {
    await p.goto(fallbackHref);
    await settle(p);
    await expect(p.getByTestId('episodes-count')).toContainText(`${fallbackCount} run`);
    await expect(p.getByRole('link', { name: 'Remove filter Fallback target' })).toBeVisible();
    await shot(p, 'W13-fallback-runs', false);
  } finally {
    await p.close();
  }
});

test('W14 honest-pass: 70% goal line and Two-Key honest pass per model', async () => {
  const src = readFileSync(
    join(root, 'apps', 'web', 'components', 'results', 'FrontierChart.tsx'),
    'utf8',
  );
  expect(src).toContain('const TARGET_X = 30;');
  expect(src).toContain("text: '70% honest-pass goal'");
  await page.goto('/results');
  await settle(page);
  await page.getByRole('tab', { name: 'Frontier' }).click();
  const list = page.locator('[data-slot="honest-pass"] li');
  const models = Object.entries(summary.models).filter(
    ([, m]) => m.gates.G4.honestInterrupted !== null,
  );
  await expect(list).toHaveCount(models.length);
  for (const [i, [id, m]] of models.entries()) {
    const passed = m.cleanWithProposal - m.gates.G4.honestInterruptedCount;
    await expect(list.nth(i)).toContainText(`Two-Key honest pass, ${short(id)}:`);
    await expect(list.nth(i)).toContainText(`(${passed} of ${m.cleanWithProposal})`);
    await expect(list.nth(i)).toContainText('goal 70%');
  }
  await shot(page, 'W14-frontier-honest-pass');
});

test('W15 unenforceable details: size is the agent’s job; product detail is LLM-graded', async () => {
  await page.goto('/rules/new?__state=success');
  await settle(page);
  const size = page.locator('main li, main [data-slot="rule-line"]').filter({ hasText: 'Size' });
  await expect(size.first()).toContainText("Agent's job — not checked by Two-Key");
  await size.first().scrollIntoViewIfNeeded();
  await shot(page, 'W15-size-advisory');
  // The product-detail metric renders in one place, and that place says LLM-graded.
  const out = execFileSync('git', ['grep', '-n', 'productDetailOk', '--', 'app', 'components'], {
    cwd: join(root, 'apps', 'web'),
    encoding: 'utf8',
  });
  const shown = out.split('\n').filter((l) => l.includes('Product details'));
  for (const l of shown) expect(l).toContain('LLM-graded');
  const page_ = readFileSync(
    join(root, 'apps', 'web', 'app', 'results', 'episodes', '[id]', 'page.tsx'),
    'utf8',
  );
  expect(page_).toContain('Product details right (LLM-graded)');
  expect(readFileSync(join(root, 'docs', 'SPIKE_RESULTS.md'), 'utf8')).toContain(
    '## R19 Channel3 structured attributes',
  );
});

test('W16 arithmetic: the header numbers equal computeMetrics output', async () => {
  await page.goto('/results');
  await settle(page);
  const header = page.locator('main p').filter({ hasText: 'gate decisions' }).first();
  await expect(header).toContainText(`${n(summary.totals.runs)} runs`);
  await expect(header).toContainText(`${n(summary.totals.gateDecisions)} gate decisions`);
  await expect(header).toContainText(`${n(summary.headline.attacked)} attacked runs`);
  await expect(header).toContainText(
    `${summary.headline.attackerPayments} attacker payments under Two-Key`,
  );
  // Every proposal is decided under all 5 gate conditions (G0–G4).
  expect(summary.totals.gateDecisions).toBe(summary.totals.proposals * 5);
  await shot(page, 'W16-header', false);
});

test('W17 + W21 landing: eyebrow and the fictional-merchants footer', async () => {
  await page.goto('/');
  await settle(page);
  await expect(
    page.getByText('Not a shopping agent. The lock on its wallet.', { exact: true }),
  ).toBeVisible();
  await shot(page, 'W21-landing-eyebrow', false);
  const footer = page.locator('footer').last();
  await expect(footer).toContainText(
    'All products and merchants are fictional PayPal sandbox accounts.',
  );
  await footer.scrollIntoViewIfNeeded();
  await shot(page, 'W17-footer-fictional', false);
});

test('W18 + W22 explorer footer: sources, licences, Channel3 decision, LLM cost', async () => {
  await page.goto('/results');
  await settle(page);
  const footer = page.locator('[data-slot="data-footer"]');
  const licences = JSON.parse(
    readFileSync(join(root, 'apps', 'web', 'public', 'licences.json'), 'utf8'),
  ) as { sources: { name: string; licence: string; commit: string | null }[] };
  for (const s of licences.sources) {
    const li = footer.locator('li').filter({ hasText: s.name });
    await expect(li).toContainText(s.licence);
    if (s.commit) await expect(li).toContainText(s.commit.slice(0, 7));
  }
  await expect(footer).toContainText(
    'Decision: Public explorer shows listing IDs and structured fields only.',
  );
  await expect(
    footer.getByRole('link', { name: 'Data licences and provenance (DATA_LICENCES.md)' }),
  ).toBeVisible();
  await expect(footer).toContainText(
    `Total LLM cost for these runs: $${summary.totals.totalCostUsd.toFixed(2)}`,
  );
  await footer.scrollIntoViewIfNeeded();
  await shot(page, 'W18-W22-data-footer', false);
});

test('W23 licence: Community fallback, no console errors, one warning', async ({ browser }) => {
  const ctx = await browser.newContext({
    storageState: await context.storageState(),
    viewport: { width: 1440, height: 1000 },
  });
  const p = await ctx.newPage();
  const errors: string[] = [];
  const warnings: string[] = [];
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (m.type() === 'warning' && m.text().includes('AG Grid')) warnings.push(m.text());
    if (m.type() === 'warning' && m.text().includes(AG_GRID_WARNING)) warnings.push(m.text());
  });
  p.on('pageerror', (e) => errors.push(e.message));
  try {
    await p.goto('/history');
    await settle(p);
    await expect(p.locator('.ag-root-wrapper').first()).toBeVisible();
    await expect(p.locator('[row-id]').first()).toBeVisible();
    await p.waitForTimeout(1_500);
    expect(errors, 'console errors').toEqual([]);
    const unique = [...new Set(warnings)];
    expect(unique).toHaveLength(1);
    expect(unique[0]).toContain(AG_GRID_WARNING);
    await shot(p, 'W23-history-community', false);
  } finally {
    await ctx.close();
  }
});
