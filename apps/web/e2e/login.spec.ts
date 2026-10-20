import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { expect, test } from '@playwright/test';

const EMAIL = 'maya@twokey.demo';

/** Only DEMO_PASSWORD is read from .env.gateway; it is never logged. */
function demoPassword(): string {
  // testDir is apps/web/e2e; .env.gateway sits at the repository root.
  const file = join(test.info().project.testDir, '..', '..', '..', '.env.gateway');
  const value = process.env.DEMO_PASSWORD || parseEnv(readFileSync(file, 'utf8')).DEMO_PASSWORD;
  if (!value) throw new Error('DEMO_PASSWORD is not set in .env.gateway');
  return value;
}

test('wrong password stays on /login with one plain message', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Next's route announcer is also role=alert; take the form's own message.
  await expect(page.locator('form [role="alert"]')).toHaveText('Wrong email or password');
  expect(new URL(page.url()).pathname).toBe('/login');
});

test('maya signs in, lands on /onboarding/paypal and /api/me knows her', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(demoPassword());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/onboarding\/paypal$/);
  expect(page.url()).toMatch(/\/onboarding\/paypal$/);

  // Same browser context, so the session cookie goes along.
  const res = await page.request.get('/api/me');
  expect(res.status()).toBe(200);
  const me = (await res.json()) as { userId?: unknown; role?: unknown };
  expect(me.role).toBe('user');
  expect(me.userId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
});

test('a fresh context without cookies gets 401 from /api/me', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const res = await context.request.get('/api/me');
    expect(res.status()).toBe(401);
  } finally {
    await context.close();
  }
});
