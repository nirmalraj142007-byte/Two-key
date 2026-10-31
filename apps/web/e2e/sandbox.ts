import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { expect, type Page } from '@playwright/test';

// Helpers for the specs that spend real PayPal sandbox money (happy.spec.ts, failure.spec.ts).
// They need the full local stack (npm run dev), local Postgres and a user with a saved PayPal
// wallet and a signed rules card. judge1 is the default (db:seed-users + demo setup);
// E2E_USER picks another one, for example e2e@twokey.demo.

const root = join(__dirname, '..', '..', '..');

function gatewayEnv(): Record<string, string | undefined> {
  try {
    return parseEnv(readFileSync(join(root, '.env.gateway'), 'utf8'));
  } catch {
    return {};
  }
}

/** Fails fast with one clear message instead of timing out later. Never prints a value. */
export function sandboxLogin(): { email: string; password: string } {
  if (process.env.E2E_SANDBOX !== '1') {
    throw new Error(
      'This spec spends real PayPal sandbox money. Set E2E_SANDBOX=1 to run it (needs npm run dev).',
    );
  }
  const file = gatewayEnv();
  const missing: string[] = [];
  const password = process.env.DEMO_PASSWORD || file.DEMO_PASSWORD;
  if (!password) missing.push('DEMO_PASSWORD');
  if (!(process.env.PAYPAL_CLIENT_ID || file.PAYPAL_CLIENT_ID)) missing.push('PAYPAL_CLIENT_ID');
  if (!(process.env.PAYPAL_CLIENT_SECRET || file.PAYPAL_CLIENT_SECRET)) {
    missing.push('PAYPAL_CLIENT_SECRET');
  }
  if (missing.length > 0 || !password) {
    throw new Error(
      `E2E_SANDBOX=1 needs these in the environment or .env.gateway: ${missing.join(', ')}`,
    );
  }
  return { email: process.env.E2E_USER || 'judge1@twokey.demo', password };
}

export async function signIn(page: Page): Promise<void> {
  const { email, password } = sandboxLogin();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/**
 * Starts a console run with a scripted model and returns the card of the proposal it makes.
 * Fails at once, with the console's own sentence, when the run cannot start (no wallet, no
 * signed card, scripted models not allowed).
 */
export async function runScripted(page: Page, script: 'happy' | 'attack' | 'anomaly') {
  await page.goto(`/agent?model=scripted:${script}`);
  const send = page.getByRole('button', { name: 'Send to agent' });
  await expect(send, 'the console needs a saved wallet and a signed rules card').toBeEnabled();
  await send.click();
  const alert = page.locator('main [role="alert"]');
  const card = page.locator('[data-slot="proposal-card"]').first();
  await expect(card.or(alert.first())).toBeVisible({ timeout: 60_000 });
  if (!(await card.isVisible())) {
    throw new Error(`The run did not start: ${(await alert.first().innerText()).trim()}`);
  }
  return card;
}
