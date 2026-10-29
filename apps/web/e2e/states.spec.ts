import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';

// Every screen x state, forced with ?__state= (lib/test-states.ts, dev builds only), saved to
// docs/evidence/states/<screen>-<state>.png. Needs web (next dev) and local Postgres for sign-in.
// Forced states use fixtures or real data and make no PayPal or gateway writes.

const EMAIL = 'states-e2e@twokey.demo';
const root = join(__dirname, '..', '..', '..');
const OUT = join(root, 'docs', 'evidence', 'states');
const PHONE_HOLD = '01900000-0000-7000-8000-00000000c001';

interface Screen {
  screen: string;
  path: string | ((page: Page) => Promise<string>);
  states: string[];
  mobile?: boolean;
  signedOut?: boolean;
}

/** One recorded episode's detail page, from the public episodes API. */
async function firstEpisode(page: Page): Promise<string> {
  const res = await page.request.get('/api/results/episodes');
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { rows?: { episodeId?: string }[] };
  const id = body.rows?.find((r) => r.episodeId)?.episodeId;
  if (!id) throw new Error('no recorded episode in /api/results/episodes');
  return `/results/episodes/${id}`;
}

const SCREENS: Screen[] = [
  {
    screen: 'login',
    path: '/login',
    states: ['empty', 'loading', 'error', 'success'],
    signedOut: true,
  },
  {
    screen: 'connect-paypal',
    path: '/onboarding/paypal',
    states: ['empty', 'loading', 'error', 'saved'],
  },
  {
    screen: 'paypal-return',
    path: '/onboarding/paypal/return',
    states: ['cancelled', 'expired', 'mismatch', 'saving', 'error', 'saved'],
  },
  {
    screen: 'rules',
    path: '/rules/new',
    states: ['empty', 'loading', 'error', 'partial', 'success'],
  },
  {
    screen: 'connect-agent',
    path: '/onboarding/agent',
    states: ['empty', 'loading', 'error', 'partial', 'success'],
  },
  {
    screen: 'console',
    path: '/agent',
    states: ['empty', 'loading', 'error', 'partial', 'success'],
  },
  {
    screen: 'approvals',
    path: '/approvals',
    states: ['empty', 'loading', 'error', 'partial', 'success'],
  },
  {
    screen: 'phone-approval',
    path: `/m/approve/${PHONE_HOLD}`,
    states: ['loading', 'error', 'voided', 'elsewhere', 'success'],
    mobile: true,
  },
  {
    screen: 'history',
    path: '/history',
    states: ['empty', 'loading', 'error', 'partial', 'success'],
  },
  {
    screen: 'merchants',
    path: '/merchants',
    states: ['loading', 'error', 'fallback', 'partial', 'success'],
  },
  {
    screen: 'results',
    path: '/results',
    states: ['empty', 'loading', 'error', 'partial', 'success', 'judge'],
  },
  {
    screen: 'episodes',
    path: '/results/episodes',
    states: ['empty', 'loading', 'error', 'success'],
  },
  {
    screen: 'episode',
    path: firstEpisode,
    states: ['loading', 'error', 'partial', 'pending', 'success'],
  },
  {
    screen: 'hijack',
    path: '/hijack',
    states: ['empty', 'loading', 'error', 'rate-limited', 'replay', 'caps', 'success'],
  },
  {
    screen: 'settings',
    path: '/settings',
    states: ['empty', 'loading', 'saving', 'error', 'partial', 'success'],
  },
];

const FORBIDDEN = /\bundefined\b|\bNaN\b|Error:/;

let context: BrowserContext;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  const env = parseEnv(readFileSync(join(root, '.env.gateway'), 'utf8'));
  const password = process.env.DEMO_PASSWORD || env.DEMO_PASSWORD || '';
  if (!password) throw new Error('.env.gateway needs DEMO_PASSWORD');
  execSync(`npm run db:seed-users -- --email ${EMAIL}`, { cwd: root, stdio: 'ignore' });

  context = await browser.newContext();
  page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.pathname !== '/login', { timeout: 60_000 });
});

test.afterAll(async () => {
  await context?.close();
});

/** Waits for the page to settle, hides the dev overlay, checks the text, saves the screenshot. */
async function capture(p: Page, name: string) {
  await p.waitForLoadState('load');
  await p.locator('main').first().waitFor({ state: 'visible', timeout: 30_000 });
  // Client components read the forced state after mount; charts and grids load lazily.
  await p.waitForTimeout(1_500);
  await p.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  const text = (await p.locator('body').innerText()).trim();
  // Not blank: some text, and the main content takes real space (skeletons count).
  expect(text.length, `${name}: page has no text`).toBeGreaterThan(10);
  const box = await p.locator('main').first().boundingBox();
  expect(box?.height ?? 0, `${name}: main content is empty`).toBeGreaterThan(120);
  expect(text, `${name}: shows a raw value or error`).not.toMatch(FORBIDDEN);
  await p.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}

for (const s of SCREENS) {
  test(`${s.screen}: every state`, async ({ browser }) => {
    test.setTimeout(180_000);
    const ctx = s.signedOut
      ? await browser.newContext()
      : s.mobile
        ? await browser.newContext({
            storageState: await context.storageState(),
            viewport: { width: 390, height: 844 },
          })
        : context;
    const p = ctx === context ? page : await ctx.newPage();
    try {
      const base = typeof s.path === 'string' ? s.path : await s.path(p);
      for (const state of s.states) {
        const sep = base.includes('?') ? '&' : '?';
        await p.goto(`${base}${sep}__state=${state}`);
        await capture(p, `${s.screen}-${state}`);
      }
    } finally {
      if (ctx !== context) await ctx.close();
    }
  });
}

test('error page: an unexpected render error', async () => {
  await page.goto('/history?__state=crash');
  await expect(page.getByRole('heading', { name: 'This page didn’t load' })).toBeVisible({
    timeout: 30_000,
  });
  await capture(page, 'app-error');
});

test('not found page', async () => {
  const res = await page.goto('/no-such-page');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await capture(page, 'app-not-found');
});

test('degraded PayPal banner', async () => {
  await page.goto('/results?__state=degraded');
  await expect(page.locator('[data-slot="health-banner"]')).toHaveText(
    'PayPal sandbox is degraded — purchases may be slow',
  );
  await capture(page, 'app-degraded');
});
