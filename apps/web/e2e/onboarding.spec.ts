import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { expect, type Page, test } from '@playwright/test';
import postgres from 'postgres';
import { uuidv7 } from 'uuidv7';

// Needs the full local stack (npm run dev, local Postgres, npm run db:seed). PayPal approval is
// not automated; this covers sign in -> rules (compile mocked at the network layer) -> sign ->
// card page. The mock writes the draft row the real compile route would have written, so the
// gateway signs a real stored draft.

const EMAIL = 'onboarding-e2e@twokey.demo';
const DEMO =
  'Running shoes, size 10, under $70, only Stride Supply or Peak Outfitters, one pair, this week.';

const root = join(__dirname, '..', '..', '..');
let env: { DATABASE_URL: string; DEMO_PASSWORD: string };
let sql: postgres.Sql;

test.beforeAll(() => {
  const file = parseEnv(readFileSync(join(root, '.env.gateway'), 'utf8'));
  const DATABASE_URL = process.env.DATABASE_URL || file.DATABASE_URL;
  const DEMO_PASSWORD = process.env.DEMO_PASSWORD || file.DEMO_PASSWORD;
  if (!DATABASE_URL || !DEMO_PASSWORD)
    throw new Error('.env.gateway needs DATABASE_URL and DEMO_PASSWORD');
  env = { DATABASE_URL, DEMO_PASSWORD };
  // A fresh-user account, created through the same script judges' accounts use.
  execSync(`npm run db:seed-users -- --email ${EMAIL}`, { cwd: root, stdio: 'ignore' });
  sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
});

test.afterAll(async () => {
  await sql?.end();
});

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(env.DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/onboarding\/paypal$/);
}

/** Inserts the draft the compile route would have stored, and returns its response body. */
async function compileResponse() {
  const [user] = await sql<{ id: string; role: string }[]>`
    select id, role from users where email = ${EMAIL}`;
  if (!user) throw new Error('e2e user missing');
  const stores = await sql<{ id: string; slug: string }[]>`
    select id, slug from merchants where slug in ('stride-supply', 'peak-outfitters') order by slug desc`;
  const [prev] = await sql<{ v: number | null }[]>`
    select max(version)::int as v from rule_cards where user_id = ${user.id}`;
  const version = (prev?.v ?? 0) + 1;
  const card = {
    version,
    userId: user.id,
    currency: 'USD',
    perItemCapCents: 7000,
    perOrderCapCents: 7000,
    allowedMerchantIds: stores.map((s) => s.id),
    maxQtyPerOrder: 1,
    frequency: { maxPurchases: 5, windowHours: 24 },
    holdTimeoutMinutes: 1440,
    anomaly: { priceRatioThreshold: 1.3 },
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    advisory: [{ key: 'size', value: '10', label: 'Size' }],
  };
  const enforcement = {
    perItemCapCents: 'enforced',
    allowedMerchantIds: 'enforced',
    maxQtyPerOrder: 'enforced',
    perOrderCapCents: 'default',
    frequency: 'default',
    expiresAt: 'enforced',
    holdTimeoutMinutes: 'default',
    size: 'advisory',
  };
  const [row] = await sql<{ id: string }[]>`
    insert into rule_cards (id, user_id, version, status, nl_request, rules, enforcement, compiler_model)
    values (${uuidv7()}, ${user.id}, ${version}, 'draft', ${DEMO}, ${sql.json(card)}, ${sql.json(enforcement)}, 'e2e-mock')
    returning id`;
  return {
    draftId: row?.id ?? null,
    card,
    enforcement,
    advisory: card.advisory,
    warnings: [],
    needsInput: [],
  };
}

test('sign in -> build rules -> confirm & sign -> signed card page', async ({ page }) => {
  await signIn(page);
  const steps = page.getByRole('navigation', { name: 'Setup progress' });
  await expect(steps.getByRole('link', { name: /Connect PayPal/ })).toBeVisible();
  await expect(steps.getByRole('link', { name: /Your rules/ })).toBeVisible();
  await expect(steps.getByRole('link', { name: /Your agent/ })).toBeVisible();
  await expect(page.getByText('Connect PayPal once')).toBeVisible();

  let compileCalls = 0;
  await page.route('**/api/rules/compile', async (route) => {
    compileCalls++;
    expect(route.request().postDataJSON()).toEqual({ request: DEMO });
    const body = await compileResponse();
    await new Promise((r) => setTimeout(r, 400)); // long enough to see the skeleton
    await route.fulfill({ status: 200, json: body });
  });

  await steps.getByRole('link', { name: /Your rules/ }).click();
  await page.waitForURL(/\/rules\/new$/);
  const textarea = page.getByLabel('What may your agent buy?');
  await expect(textarea).toHaveAttribute('placeholder', DEMO);
  await textarea.fill(DEMO);
  await page.getByRole('button', { name: 'Build my rules' }).click();
  await expect(page.getByText('Building your rules…').first()).toBeVisible();

  await expect(page.getByText('Check your rules')).toBeVisible();
  expect(compileCalls).toBe(1);
  const stores = page.locator('[data-slot="rule-line"]', { hasText: 'Stores' });
  await expect(stores).toContainText('Stride Supply or Peak Outfitters');
  await expect(stores).toContainText('Enforced at payment');
  const size = page.locator('[data-slot="rule-line"]', { hasText: 'Size' });
  await expect(size).toContainText("Agent's job — not checked by Two-Key");

  await page.getByRole('button', { name: 'Confirm & sign' }).click();
  await page.waitForURL(/\/rules\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split('/').pop() ?? '';

  await expect(page.getByText('From here, no AI decides.')).toBeVisible();
  await expect(page.getByTestId('fingerprint')).toHaveText(/^[A-Za-z0-9_-]{8}$/);
  // the shared /rules header refreshes after signing: step 2 is done
  await expect(steps.getByRole('link', { name: /Your rules \(done\)/ })).toBeVisible();
  await expect(page.locator('[data-slot="rule-line"]', { hasText: 'Stores' })).toContainText(
    'Enforced at payment',
  );
  await expect(page.getByRole('link', { name: 'Change rules' })).toHaveAttribute(
    'href',
    '/rules/new',
  );

  const [row] = await sql<{ status: string; hmac: string | null }[]>`
    select status, hmac from rule_cards where id = ${id}`;
  expect(row?.status).toBe('signed');
  expect(row?.hmac).toBeTruthy();
});

test('compiler down (503 manual) shows the manual rules form', async ({ page }) => {
  await signIn(page);
  await page.route('**/api/rules/compile', (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: { code: 'UPSTREAM_LLM', message: 'down', requestId: 'r' },
        fallback: 'manual',
      },
    }),
  );
  await page.goto('/rules/new');
  await page.getByLabel('What may your agent buy?').fill(DEMO);
  await page.getByRole('button', { name: 'Build my rules' }).click();
  await expect(page.getByText('Enter your rules by hand')).toBeVisible();
  await expect(page.getByLabel('Stride Supply')).toBeVisible();
  await expect(page.getByLabel('Most per item ($)')).toBeVisible();
  await expect(page.getByText('UPSTREAM_LLM')).toHaveCount(0);
});

test('PayPal cancel and a foreign approval each show one plain sentence', async ({ page }) => {
  await signIn(page);
  await page.goto('/onboarding/paypal/return?cancelled=1&approval_token_id=FOREIGN123');
  await expect(page.getByText('You cancelled in PayPal. Nothing was saved.')).toBeVisible();

  await page.goto('/onboarding/paypal/return?approval_token_id=FOREIGN123');
  await expect(
    page.getByText("This approval doesn't match your session — start again"),
  ).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});
