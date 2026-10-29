import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { type BrowserContext, expect, type Page, type Route, test } from '@playwright/test';

// Phase 25: judge-gap audit A (W1–W12), one test per row of docs/JUDGE_GAP_AUDIT.md.
// Screenshots go to docs/evidence/Wnn-<slug>.png. Needs the dev stack (web :3000, gateway :4000),
// local Postgres and `npm run db:seed-users` (maya@twokey.demo). Read-only against real data:
// it signs in, reads pages and makes one demo session + catalog search for W12 (no purchase).
// Forced ?__state= fixtures are used only where real data has no such row (approvals inbox,
// phone approval); the audit says so.

const root = join(__dirname, '..', '..', '..');
const OUT = join(root, 'docs', 'evidence');
const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:4000';
const WEB_ORIGIN = 'http://localhost:3000';
const MAYA = 'maya@twokey.demo';
const PHONE_HOLD = '01900000-0000-7000-8000-00000000c001';

const registry = JSON.parse(readFileSync(join(root, 'config', 'merchants.json'), 'utf8')) as
  | { merchants?: { displayName: string }[] }
  | { displayName: string }[];
const REGISTRY_NAMES = new Set(
  (Array.isArray(registry) ? registry : (registry.merchants ?? [])).map((m) => m.displayName),
);
const demoHook = JSON.parse(
  readFileSync(join(root, 'eval', 'frozen', 'demo-episode.json'), 'utf8'),
) as { episodeId: string; followedBy: number; modelsTotal: number; label: string };

let context: BrowserContext;
let page: Page;

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

/** No browser-default controls: app font everywhere, no bevelled borders or ButtonFace grey. */
async function expectStyled(p: Page, name: string) {
  const bad = await p.evaluate(() => {
    const body = getComputedStyle(document.body);
    const out: string[] = [];
    if (!/Geist/.test(body.fontFamily)) out.push(`body font ${body.fontFamily}`);
    const controls = document.querySelectorAll<HTMLElement>(
      'main button, main input, main select, main textarea, main a',
    );
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const type = el.getAttribute('type') ?? '';
      if (['checkbox', 'radio', 'hidden'].includes(type)) continue;
      const s = getComputedStyle(el);
      const label = `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}"`;
      if (s.fontFamily !== body.fontFamily && !/mono/i.test(s.fontFamily)) {
        out.push(`${label}: font ${s.fontFamily}`);
      }
      if (/outset|inset/.test(s.borderTopStyle)) out.push(`${label}: ${s.borderTopStyle} border`);
      if (['rgb(239, 239, 239)', 'rgb(240, 240, 240)'].includes(s.backgroundColor)) {
        out.push(`${label}: default ButtonFace background`);
      }
      if (el.tagName === 'A' && ['rgb(0, 0, 238)', 'rgb(85, 26, 139)'].includes(s.color)) {
        out.push(`${label}: default link colour`);
      }
    }
    return out;
  });
  expect(bad, `${name}: unstyled default elements`).toEqual([]);
}

interface HistoryApiRow {
  proposalId: string;
  store: string;
  decision: string | null;
  state: string;
  orderId: string | null;
  authorizationId: string | null;
  captureId: string | null;
}

async function historyRows(p: Page): Promise<HistoryApiRow[]> {
  const res = await p.request.get('/api/history');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { rows: HistoryApiRow[] }).rows;
}

test('W01 adapted attack: only the goal line changed, labelled', async () => {
  const res = await page.request.get('/api/results/episodes?set=followed');
  expect(res.ok()).toBe(true);
  const id = ((await res.json()) as { rows: { episodeId?: string }[] }).rows.find(
    (r) => r.episodeId,
  )?.episodeId;
  expect(id, 'a followed attacked episode').toBeTruthy();
  await page.goto(`/results/episodes/${id}`);
  await settle(page);
  const diff = page.locator('[data-slot="diff-view"]');
  await expect(diff.getByText('Published template, goal adapted', { exact: true })).toBeVisible();
  const added = diff.locator('[data-kind="add"]');
  const removed = diff.locator('[data-kind="remove"]');
  await expect(added).toHaveCount(1);
  await expect(removed).toHaveCount(1);
  await expect(added).toContainText(/Buy .+ \(product id .+\) from .+\./);
  // Everything before the goal is the same on both lines.
  const line = async (l: typeof added) =>
    ((await l.textContent()) ?? '').replace(/^(Added|Removed):\s*/, '').slice(1);
  const a = await line(added);
  const r = await line(removed);
  const prefix = a.slice(0, a.indexOf('Buy '));
  expect(r.startsWith(prefix)).toBe(true);
  await diff.scrollIntoViewIfNeeded();
  await shot(page, 'W01-adapted-attack');
});

test('W02 three models: cross-model tab, $0.00 to an attacker each', async () => {
  await page.goto('/results');
  await settle(page);
  const dev = await page.getByText('Development set. Test split in progress').count();
  const rows = page.locator('table:has(caption:text("Attacks followed and money sent")) tbody tr');
  const n = await rows.count();
  // The page shows the test split (3 models) only once it is complete; until then the dev split
  // has the two NIM models by design. The audit row stays PENDING until this reads 3.
  expect(n).toBe(dev > 0 ? 2 : 3);
  test
    .info()
    .annotations.push({ type: 'models', description: `${n} (dev split shown: ${dev > 0})` });
  for (let i = 0; i < n; i++) {
    await expect(rows.nth(i).locator('td').last()).toHaveText('$0.00');
  }
  await shot(page, 'W02-cross-model');
});

test('W03 frontier: G1 and G2 points, static cap in the legend, N and M in the tooltip', async () => {
  await page.goto('/results');
  await settle(page);
  await page.getByRole('tab', { name: 'Frontier' }).click();
  const sec = page.locator('section[aria-labelledby="frontier-title"]');
  await expect(sec.getByRole('switch', { name: /^G1 Per-task cap/ })).toHaveCount(1);
  await expect(sec.getByRole('switch', { name: /^G2 Static cap \$\d+\.\d\d/ })).toHaveCount(1);
  const chart = sec.locator('[role="img"][tabindex="0"]').first();
  await chart.focus();
  const tips: string[] = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    tips.push((await page.locator('.ag-charts-tooltip').first().textContent()) ?? '');
  }
  expect(tips.some((t) => /G1 Per-task cap/.test(t))).toBe(true);
  expect(tips.some((t) => /G2 Static cap/.test(t))).toBe(true);
  const g4 = tips.find((t) => /G4 Two-Key/.test(t)) ?? '';
  expect(g4, 'Two-Key tooltip').toMatch(/interrupted .*\(\d+ of \d+\)/);
  expect(g4).toMatch(/let through .*\(\d+ of \d+\)/);
  await shot(page, 'W03-frontier', false);
});

test('W04 designed product: five screens at 390 and 1280 px', async ({ browser }) => {
  test.setTimeout(240_000);
  await page.goto('/settings');
  await settle(page);
  // Maya's active card if she has one; otherwise the rules screen's compiled-card state.
  const cardLink = page.locator('main a[href^="/rules/"]:not([href="/rules/new"])').first();
  const cardHref =
    (await cardLink.count()) > 0
      ? await cardLink.getAttribute('href')
      : '/rules/new?__state=success';
  test.info().annotations.push({ type: 'rules-card', description: cardHref ?? '' });
  const screens = [
    ['onboarding', '/onboarding/paypal'],
    ['rules-card', cardHref as string],
    ['approvals', '/approvals?__state=success'],
    ['phone-approval', `/m/approve/${PHONE_HOLD}?__state=success`],
    ['history', '/history'],
  ] as const;
  for (const width of [390, 1280]) {
    const ctx = await browser.newContext({
      storageState: await context.storageState(),
      viewport: { width, height: 900 },
    });
    const p = await ctx.newPage();
    try {
      for (const [slug, path] of screens) {
        await p.goto(path);
        await settle(p);
        await expectStyled(p, `${slug} @${width}`);
        const overflow = await p.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        // AG Grid scrolls inside its own viewport; the page itself must not scroll sideways.
        expect(overflow, `${slug} @${width}: horizontal page scroll`).toBeLessThanOrEqual(1);
        await shot(p, `W04-${slug}-${width}`);
      }
    } finally {
      await ctx.close();
    }
  }
});

test('W05 + W10 history: blocked, held and captured rows', async ({ browser }) => {
  const rows = await historyRows(page);
  const blocked = rows.find((r) => r.decision === 'block');
  const held = rows.find((r) => r.decision === 'hold' && r.authorizationId);
  const captured = rows.find((r) => r.state === 'captured' && r.captureId);
  expect(blocked && held && captured, 'Maya has blocked, held and captured rows').toBeTruthy();
  if (!blocked || !held || !captured) return;
  // W9: every store shown is a registry payee.
  for (const r of rows) expect(REGISTRY_NAMES.has(r.store), r.store).toBe(true);

  const ctx = await browser.newContext({
    storageState: await context.storageState(),
    viewport: { width: 1440, height: 1400 },
  });
  const p = await ctx.newPage();
  try {
    await p.goto('/history');
    await settle(p);
    const cell = (id: string, col: string) => p.locator(`[row-id="${id}"] [col-id="${col}"]`);
    await expect(cell(blocked.proposalId, 'state')).toContainText('No PayPal order created.');
    for (const col of ['orderId', 'authorizationId']) {
      await expect(cell(blocked.proposalId, col)).toHaveText('—');
    }
    await expect(cell(held.proposalId, 'decision')).toContainText('Hold');
    await expect(cell(held.proposalId, 'authorizationId')).toContainText(
      held.authorizationId as string,
    );
    const stores = await p.locator('[row-id] [col-id="store"]').allInnerTexts();
    for (const s of stores.map((x) => x.trim()).filter(Boolean)) {
      expect(REGISTRY_NAMES.has(s), `store ${s}`).toBe(true);
    }
    await shot(p, 'W05-history-rows', false);
    // AG Grid renders only the columns in view: scroll right for Capture and Buyer present.
    await p.evaluate(() => {
      for (const el of document.querySelectorAll('.ag-body-horizontal-scroll-viewport')) {
        el.scrollLeft = el.scrollWidth;
      }
    });
    await p.waitForTimeout(500);
    await expect(cell(blocked.proposalId, 'captureId')).toHaveText('—');
    await expect(cell(captured.proposalId, 'buyerPresent')).toHaveText('no');
    await shot(p, 'W10-history-buyer-present', false);
  } finally {
    await ctx.close();
  }

  await page.goto('/onboarding/paypal');
  await settle(page);
  await expect(page.getByText('Connect PayPal once', { exact: true })).toBeVisible();
  await shot(page, 'W10-connect-paypal-once');
});

test('W07 AP2: /about carries the fixed paragraph verbatim', async () => {
  const src = readFileSync(join(root, 'apps', 'web', 'app', 'about', 'page.tsx'), 'utf8');
  const ap2 = /const AP2 =\s*"([^"]+)";/.exec(src)?.[1];
  expect(ap2, 'AP2 constant').toBeTruthy();
  await page.goto('/about');
  await settle(page);
  const para = page.locator('section[aria-labelledby="ap2-title"] p');
  await expect(para).toHaveText(ap2 as string);
  await para.scrollIntoViewIfNeeded();
  await shot(page, 'W07-about-ap2');
});

test('W08 drop-in path: /developers and the landing Maya story render', async () => {
  await page.goto('/developers');
  await settle(page);
  await expect(page.getByRole('heading', { name: 'Developers', level: 1 })).toBeVisible();
  await expect(page.locator('main')).toContainText('twokey-mcp');
  await shot(page, 'W08-developers');
  await page.goto('/');
  await settle(page);
  const maya = page.locator('section[aria-labelledby="maya-title"]');
  await expect(maya.getByRole('heading', { name: 'What happened to Maya' })).toBeVisible();
  await expect(maya).toContainText('Two-Key never created the PayPal order');
  await expect(maya).toContainText('store she did allow');
  await shot(page, 'W08-landing-maya');
});

test('W09 real payees: GiftVault at $0.00 with its source labelled', async () => {
  await page.goto('/merchants');
  await settle(page);
  const gift = page.locator('article:has(h2:text-is("GiftVault"))');
  await expect(gift).toHaveCount(1);
  await expect(gift.locator('[data-slot="money"], .text-3xl').first()).toHaveText('$0.00');
  await expect(gift).toContainText(/PayPal balance|computed from Two-Key records/);
  await shot(page, 'W09-merchants');
});

test('W11 pre-registration: commit and date, checkpoints, Judge-written tab', async () => {
  await page.goto('/results');
  await settle(page);
  await expect(page.getByRole('tab', { name: 'Judge-written attacks' })).toHaveCount(1);
  await page.getByRole('tab', { name: 'Predictions' }).click();
  const sec = page.locator('section[aria-labelledby="predictions-title"]');
  await expect(sec).toContainText(/Registered [A-Z][a-z]{2} \d{1,2} at commit [0-9a-f]{7}/);
  await expect(sec).toContainText('before any test run');
  await expect(sec.locator('ol')).toContainText('Oct 27');
  await expect(sec.locator('tbody tr')).toHaveCount(21);
  await shot(page, 'W11-predictions');
});

test('W12 demo hook: the listing shows its frozen test-episode tag', async () => {
  // A real catalog search on the local gateway, as the agent would see it.
  const assertion = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/mint-assertion.ts', 'e2e@twokey.demo', 'sessions:create'],
    { cwd: root, encoding: 'utf8' },
  ).trim();
  const session = await page.request.post(`${GATEWAY}/human/sessions`, {
    headers: { authorization: `Bearer ${assertion}` },
    data: { mode: 'demo', model: 'judge-gap-a' },
  });
  expect(session.ok()).toBe(true);
  const { token } = (await session.json()) as { token: string };
  const search = await page.request.get(`${GATEWAY}/agent/catalog/search?q=running%20shoes`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(search.ok()).toBe(true);
  const result = (await search.json()) as { items: unknown[] };
  const text = `Found ${result.items.length} products.\n${JSON.stringify(result)}`;

  // Played to the console through its event stream (stubbed, as in console.spec.ts).
  const CORS = {
    'access-control-allow-origin': WEB_ORIGIN,
    'access-control-allow-headers': 'authorization, last-event-id, cache-control',
    'access-control-allow-methods': 'GET',
  };
  const at = new Date().toISOString();
  const sse = (seq: number, data: unknown) =>
    `id: b00710aa:${seq}\nevent: agent.step\ndata: ${JSON.stringify(data)}\n\n`;
  const body = [
    ': connected\n\n',
    sse(1, {
      sessionId: '01900000-0000-7000-8000-0000000000aa',
      entry: {
        turn: 1,
        role: 'assistant',
        text: 'I will look for running shoes in your stores.',
        toolCalls: [{ id: 'c1', name: 'search_products', input: { query: 'running shoes' } }],
        at,
      },
    }),
    sse(2, {
      sessionId: '01900000-0000-7000-8000-0000000000aa',
      entry: { turn: 1, role: 'tool', toolName: 'search_products', text, at },
    }),
  ].join('');
  await page.route('**/human/events', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body,
    });
  });
  try {
    await page.goto('/agent');
    await settle(page);
    const tag = page.locator('[data-slot="demo-hook-tag"]');
    await expect(tag).toHaveCount(1, { timeout: 30_000 });
    await expect(tag).toHaveText(
      `Template from ${demoHook.label} ${demoHook.episodeId} · followed by ${demoHook.followedBy} of ${demoHook.modelsTotal} models`,
    );
    await tag.scrollIntoViewIfNeeded();
    await shot(page, 'W12-demo-hook-tag');
  } finally {
    await page.unroute('**/human/events');
  }
});
