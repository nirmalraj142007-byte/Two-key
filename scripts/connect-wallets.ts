/**
 * npm run demo:connect-wallets [-- --only judge2@twokey.demo] [--origin https://…]
 *
 * Saves a PayPal sandbox wallet for each demo account (maya, judge1–3) through the real
 * onboarding flow, one fresh headed Edge window per account:
 *
 *   sign in at <origin>/login → /onboarding/paypal → Connect PayPal → log in on
 *   sandbox.paypal.com as the sandbox buyer → approve → wait for the "Saved" page.
 *
 * Secrets are read from files and never printed:
 *   ~/two-key-secrets/demo-password.txt   the demo accounts' password (one line)
 *   ~/two-key-secrets/sandbox-buyer.env   SANDBOX_BUYER_EMAIL=… and SANDBOX_BUYER_PASSWORD=…
 *
 * Safety: the buyer credentials are typed only on www.sandbox.paypal.com / sandbox.paypal.com,
 * and any request to a live paypal.com host is aborted. If PayPal shows a captcha or a security
 * check, the script stops, names the account, and leaves the window open for a human.
 *
 * Run `npm run demo:setup -- --env prod` afterwards to check every wallet is active.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { type BrowserContext, chromium, type Page } from '@playwright/test';
import { DEMO_EMAILS } from './demo-lib.js';

const DEFAULT_ORIGIN = 'https://web-ycyg.onrender.com';
const SECRETS_DIR = join(homedir(), 'two-key-secrets');
const SANDBOX_HOSTS = new Set(['www.sandbox.paypal.com', 'sandbox.paypal.com']);
const SAVED_TEXT = 'Saved. Future purchases need no PayPal pop-up.';
const STEP_TIMEOUT_MS = 60_000;
/** Render free instances can take a minute to wake. */
const FIRST_LOAD_TIMEOUT_MS = 120_000;

class StopError extends Error {}

/** Values that must never reach the console; filled once the secret files are read. */
const SECRET_VALUES: string[] = [];
function redact(text: string): string {
  let out = text;
  for (const v of SECRET_VALUES) if (v) out = out.split(v).join('***');
  return out;
}

function readSecrets(): { demoPassword: string; buyerEmail: string; buyerPassword: string } {
  const demoPassword = readFileSync(join(SECRETS_DIR, 'demo-password.txt'), 'utf8').trim();
  const env: Record<string, string> = {};
  for (const line of readFileSync(join(SECRETS_DIR, 'sandbox-buyer.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m?.[1] && m[2] !== undefined) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  const buyerEmail = env.SANDBOX_BUYER_EMAIL ?? '';
  const buyerPassword = env.SANDBOX_BUYER_PASSWORD ?? '';
  if (!demoPassword) throw new StopError('demo-password.txt is empty');
  if (!buyerEmail || !buyerPassword) {
    throw new StopError('sandbox-buyer.env needs SANDBOX_BUYER_EMAIL and SANDBOX_BUYER_PASSWORD');
  }
  SECRET_VALUES.push(demoPassword, buyerPassword);
  return { demoPassword, buyerEmail, buyerPassword };
}

function isLivePayPal(host: string): boolean {
  return (host === 'paypal.com' || host.endsWith('.paypal.com')) && !SANDBOX_HOSTS.has(host);
}

/** Throws unless the page is on a sandbox PayPal host. Checked right before typing. */
function assertSandbox(page: Page): void {
  const host = new URL(page.url()).hostname;
  if (!SANDBOX_HOSTS.has(host)) throw new StopError(`refusing to type PayPal login on ${host}`);
}

/** Stops on anything that looks like a captcha or an extra security check. */
async function assertNoChallenge(page: Page, email: string): Promise<void> {
  const url = page.url().toLowerCase();
  const challenge =
    /captcha|challenge|authflow\/(stepup|safe)|\/signin\/.*verify/.test(url) ||
    (await page.locator('iframe[src*="captcha" i], iframe[title*="captcha" i], #captcha').count()) >
      0 ||
    (await page
      .getByText(/security (check|challenge)|verify (it'?s|that it'?s) you|i'?m not a robot/i)
      .count()) > 0;
  if (challenge) {
    throw new StopError(`PayPal showed a captcha or security check for ${email}`);
  }
}

async function signInToTwoKey(page: Page, origin: string, email: string, password: string) {
  await page.goto(`${origin}/login`, { timeout: FIRST_LOAD_TIMEOUT_MS });
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: STEP_TIMEOUT_MS });
}

async function loginToSandbox(page: Page, email: string, buyerEmail: string, pw: string) {
  await page.waitForURL((u) => SANDBOX_HOSTS.has(u.hostname), { timeout: STEP_TIMEOUT_MS });
  await page.waitForLoadState('domcontentloaded');
  await assertNoChallenge(page, email);

  const emailBox = page.locator('#email');
  if (await emailBox.isVisible({ timeout: STEP_TIMEOUT_MS }).catch(() => false)) {
    assertSandbox(page);
    await emailBox.fill(buyerEmail);
    const next = page.locator('#btnNext');
    if (await next.isVisible().catch(() => false)) await next.click();
  }
  const pwBox = page.locator('#password');
  await pwBox.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await assertNoChallenge(page, email);
  assertSandbox(page);
  await pwBox.fill(pw);
  await page.locator('#btnLogin').click();
}

/** Clicks PayPal's approve button (its label varies) until the flow returns to Two-Key. */
async function approve(page: Page, email: string, origin: string) {
  const back = (u: URL) => u.origin === origin;
  const approveBtn = page
    .locator('#consentButton, [data-testid="consentButton"], #payment-submit-btn')
    .or(page.getByRole('button', { name: /agree|save and continue|continue|approve/i }));
  const deadline = Date.now() + STEP_TIMEOUT_MS * 2;
  while (!back(new URL(page.url()))) {
    if (Date.now() > deadline) throw new StopError(`PayPal approval timed out for ${email}`);
    await assertNoChallenge(page, email);
    const btn = approveBtn.first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => undefined);
    }
    await page.waitForTimeout(1500);
  }
}

async function connectOne(context: BrowserContext, origin: string, email: string, s: Secrets) {
  const page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  await signInToTwoKey(page, origin, email, s.demoPassword);
  console.log(`${email}: signed in`);

  await page.goto(`${origin}/onboarding/paypal`);
  await page.getByRole('button', { name: /^Connect (a different )?PayPal/ }).click();
  await loginToSandbox(page, email, s.buyerEmail, s.buyerPassword);
  console.log(`${email}: logged in to the PayPal sandbox`);

  await approve(page, email, origin);
  await page.getByText(SAVED_TEXT).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log(`${email}: Saved`);
}

type Secrets = ReturnType<typeof readSecrets>;

async function main() {
  const { values } = parseArgs({
    options: { only: { type: 'string', multiple: true }, origin: { type: 'string' } },
  });
  const origin = new URL(values.origin ?? DEFAULT_ORIGIN).origin;
  if (!origin.startsWith('https://')) throw new StopError('origin must be https');
  const accounts = values.only?.length ? values.only : DEMO_EMAILS;
  for (const a of accounts) {
    if (!DEMO_EMAILS.includes(a)) throw new StopError(`${a} is not a demo account`);
  }
  const secrets = readSecrets();

  const browser = await chromium.launch({ channel: 'msedge', headless: false });
  const done: string[] = [];
  try {
    for (const email of accounts) {
      // A fresh context per account: no cookies or PayPal session carry over.
      const context = await browser.newContext();
      await context.route('**/*', (route) => {
        const host = new URL(route.request().url()).hostname;
        return isLivePayPal(host) ? route.abort('blockedbyclient') : route.continue();
      });
      try {
        await connectOne(context, origin, email, secrets);
        done.push(email);
        await context.close();
      } catch (err) {
        const msg = redact(err instanceof Error ? err.message : String(err));
        console.error(`${email}: stopped — ${msg}`);
        console.error('The window is left open. Close it (Ctrl-C) when done.');
        console.log(`saved: ${done.length ? done.join(', ') : 'none'}`);
        process.exitCode = 1;
        await new Promise(() => undefined); // keep the window for a human
      }
    }
  } finally {
    if (process.exitCode !== 1) await browser.close();
  }
  console.log(`saved: ${done.join(', ')}`);
  console.log('Next: npm run demo:setup -- --env prod');
}

main().catch((err) => {
  const msg =
    err instanceof Error
      ? `${err.message}
${err.stack ?? ''}`
      : String(err);
  console.error(redact(err instanceof StopError ? err.message : msg));
  process.exit(1);
});
