/**
 * npm run demo:connect-wallets [-- --only judge2 --only judge3] [--origin https://…]
 *
 * Saves a PayPal sandbox wallet for each demo account (maya, judge1–3) through the real
 * onboarding flow, one fresh headed Edge window per account:
 *
 *   sign in at <origin>/login → /onboarding/paypal → Connect PayPal → log in on
 *   sandbox.paypal.com as the sandbox buyer (email → Next → password → Log In) → approve →
 *   wait for the "Saved" page.
 *
 * Accounts whose onboarding page already says "Saved" (an active wallet) are skipped.
 *
 * Secrets are read from files and never printed:
 *   ~/two-key-secrets/demo-password.txt   the judge accounts' password (one line, public)
 *   ~/two-key-secrets/maya-password.txt   maya's own password (one line)
 *   ~/two-key-secrets/sandbox-buyer.env   SANDBOX_BUYER_EMAIL=… and SANDBOX_BUYER_PASSWORD=…
 *
 * Safety: the buyer credentials are typed only on www.sandbox.paypal.com / sandbox.paypal.com,
 * and any request to a live paypal.com host is aborted. If PayPal shows a captcha or a security
 * check, the script stops, names the account, and leaves the window open for a human. Only a
 * challenge a person can see counts: PayPal's normal login page carries an invisible reCAPTCHA
 * badge and hidden challenge markup, which are ignored.
 *
 * Run `npm run demo:setup -- --env prod` afterwards to check every wallet is active.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { type BrowserContext, chromium, type Page } from '@playwright/test';
import { DEMO_EMAILS, parseDemoAccounts } from './demo-lib.js';

const DEFAULT_ORIGIN = 'https://web-ycyg.onrender.com';
const SECRETS_DIR = join(homedir(), 'two-key-secrets');
const SANDBOX_HOSTS = new Set(['www.sandbox.paypal.com', 'sandbox.paypal.com']);
const SAVED_TEXT = 'Saved. Future purchases need no PayPal pop-up.';
const STEP_TIMEOUT_MS = 60_000;
/** Render free instances can take a minute to wake. */
const FIRST_LOAD_TIMEOUT_MS = 120_000;
/** How long the sign-in page may take to appear while a free-plan service wakes. */
const COLD_START_MS = 90_000;

/** Challenge pages PayPal redirects to; the normal /signin page is not one of them. */
const CHALLENGE_PATH =
  /\/(auth\/validatecaptcha|authflow\/(challenges?|stepup|safe)|signin\/challenge)/i;
/** Iframes of an interactive captcha. The invisible reCAPTCHA badge (size=invisible) is excluded. */
const CAPTCHA_FRAME = [
  'iframe[src*="recaptcha" i]:not([src*="size=invisible" i])',
  'iframe[src*="hcaptcha" i]',
  'iframe[src*="arkoselabs" i]',
  'iframe[src*="funcaptcha" i]',
  'iframe[title*="challenge" i]',
].join(', ');
const CHALLENGE_TEXT =
  /security (check|challenge)|verify (it'?s|that it'?s) you|i'?m not a robot|quick security check/i;

class StopError extends Error {}
/** A stop that needs waiting or a fix, not a person at the window: the browser closes. */
class WaitError extends StopError {}

/** Values that must never reach the console; filled once the secret files are read. */
const SECRET_VALUES: string[] = [];
function redact(text: string): string {
  let out = text;
  for (const v of SECRET_VALUES) if (v) out = out.split(v).join('***');
  return out;
}

function readSecrets(): {
  demoPassword: string;
  mayaPassword: string | undefined;
  buyerEmail: string;
  buyerPassword: string;
} {
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
  // maya (an unrestricted user) has her own password; the judges one is published.
  const mayaFile = join(SECRETS_DIR, 'maya-password.txt');
  const mayaPassword = existsSync(mayaFile) ? readFileSync(mayaFile, 'utf8').trim() : undefined;
  SECRET_VALUES.push(demoPassword, buyerPassword, ...(mayaPassword ? [mayaPassword] : []));
  return { demoPassword, mayaPassword, buyerEmail, buyerPassword };
}

type Secrets = ReturnType<typeof readSecrets>;

function isLivePayPal(host: string): boolean {
  return (host === 'paypal.com' || host.endsWith('.paypal.com')) && !SANDBOX_HOSTS.has(host);
}

/** Throws unless the page is on a sandbox PayPal host. Checked right before typing. */
function assertSandbox(page: Page): void {
  const host = new URL(page.url()).hostname;
  if (!SANDBOX_HOSTS.has(host)) throw new StopError(`refusing to type PayPal login on ${host}`);
}

/**
 * Stops only on a captcha or security check a person can see. Hidden markup and the invisible
 * reCAPTCHA badge on PayPal's normal login page don't count.
 */
async function assertNoChallenge(page: Page, email: string): Promise<void> {
  let frameShown = false;
  for (const frame of await page.locator(CAPTCHA_FRAME).filter({ visible: true }).all()) {
    const box = await frame.boundingBox().catch(() => null);
    // A challenge widget is at least checkbox-sized; tracking frames and badges are not.
    if (box && box.width >= 120 && box.height >= 60) frameShown = true;
  }
  const challenge =
    CHALLENGE_PATH.test(new URL(page.url()).pathname) ||
    frameShown ||
    (await page.getByText(CHALLENGE_TEXT).filter({ visible: true }).count()) > 0;
  if (challenge) {
    throw new StopError(`PayPal showed a captcha or security check for ${email}`);
  }
}

/** Declines PayPal's cookie banner (non-essential cookies) if it is showing. */
async function declineCookies(page: Page): Promise<void> {
  const decline = page
    .locator('#bannerDeclineButton')
    .or(page.getByRole('button', { name: /^(decline|reject)( all)?$/i }))
    .first();
  if (await decline.isVisible().catch(() => false)) await decline.click().catch(() => undefined);
}

/**
 * Opens /login and waits for its form, reloading while a free Render instance wakes (the first
 * request can hang or get a placeholder page) for up to COLD_START_MS.
 */
async function openLogin(page: Page, origin: string) {
  const emailBox = page.getByLabel('Email', { exact: true });
  const deadline = Date.now() + COLD_START_MS;
  for (let attempt = 1; ; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new StopError(
        `${origin}/login did not show its sign-in form within ${COLD_START_MS / 1000} s (cold start?). Run the same command again.`,
      );
    }
    try {
      await page.goto(`${origin}/login`, { timeout: left, waitUntil: 'domcontentloaded' });
      await emailBox.waitFor({ state: 'visible', timeout: Math.min(left, 30_000) });
      return;
    } catch {
      if (attempt === 1) console.log('  waiting for Two-Key to wake (free plan)…');
      await page.waitForTimeout(3_000);
    }
  }
}

/** Two-Key's own sign-in messages (apps/web/app/login/actions.ts). */
const RATE_LIMITED = /Too many sign-in attempts/i;
const WRONG_PASSWORD = /Wrong email or password/i;

async function signInToTwoKey(page: Page, origin: string, email: string, password: string) {
  await openLogin(page, origin);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Signed in (the URL leaves /login), or the form says why not.
  const alert = page.getByRole('alert');
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!new URL(page.url()).pathname.startsWith('/login')) return;
    const text = (await alert.allInnerTexts().catch(() => [])).join(' ');
    if (RATE_LIMITED.test(text)) {
      // 5 attempts per minute per IP (LOGIN_POINTS / LOGIN_WINDOW_S in apps/web/lib/rate-limit.ts).
      throw new WaitError(
        `Two-Key is rate-limiting sign-in from this network (5 attempts a minute). Wait 60 seconds, then run the same command again (accounts already saved are skipped).`,
      );
    }
    if (WRONG_PASSWORD.test(text)) {
      const file = email.startsWith('maya@') ? 'maya-password.txt' : 'demo-password.txt';
      throw new WaitError(
        `Two-Key rejected the password for ${email}: check ~/two-key-secrets/${file}. Not retrying, so the sign-in limit is not used up.`,
      );
    }
    await page.waitForTimeout(500);
  }
  throw new StopError(`signing in as ${email} did not finish within ${STEP_TIMEOUT_MS / 1000} s`);
}

/**
 * PayPal sandbox login, current layout: email → Next → password → Log In. The password step can
 * also come first (email remembered) or share a page with the email box (older layout).
 */
async function loginToSandbox(page: Page, email: string, buyerEmail: string, pw: string) {
  await page.waitForURL((u) => SANDBOX_HOSTS.has(u.hostname), { timeout: STEP_TIMEOUT_MS });
  const emailBox = page.locator('#email');
  const pwBox = page.locator('#password');
  const nextBtn = page.locator('#btnNext').or(page.getByRole('button', { name: /^next$/i }));
  const loginBtn = page.locator('#btnLogin').or(page.getByRole('button', { name: /^log ?in$/i }));

  // Wait for whichever step PayPal shows first.
  await emailBox.or(pwBox).filter({ visible: true }).first().waitFor({ timeout: STEP_TIMEOUT_MS });
  await declineCookies(page);
  await assertNoChallenge(page, email);

  if (await emailBox.isVisible().catch(() => false)) {
    assertSandbox(page);
    await emailBox.fill(buyerEmail);
    if (
      await nextBtn
        .first()
        .isVisible()
        .catch(() => false)
    )
      await nextBtn.first().click();
  }

  // After Next: the password box, or (rarely) a challenge.
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (!(await pwBox.isVisible().catch(() => false))) {
    if (Date.now() > deadline) {
      throw new StopError(`PayPal's password step never appeared for ${email}`);
    }
    await assertNoChallenge(page, email);
    await page.waitForTimeout(500);
  }
  assertSandbox(page);
  await pwBox.fill(pw);
  await loginBtn.first().click();
}

/** Clicks PayPal's approve button (its label varies) until the flow returns to Two-Key. */
async function approve(page: Page, email: string, origin: string) {
  const back = (u: URL) => u.origin === origin;
  const approveBtn = page
    .locator('#consentButton, [data-testid="consentButton"], #payment-submit-btn')
    .or(page.getByRole('button', { name: /agree|save and continue|^continue$|approve/i }));
  const deadline = Date.now() + STEP_TIMEOUT_MS * 2;
  while (!back(new URL(page.url()))) {
    if (Date.now() > deadline) throw new StopError(`PayPal approval timed out for ${email}`);
    await assertNoChallenge(page, email);
    const btn = approveBtn.first();
    if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => undefined);
    await page.waitForTimeout(1500);
  }
}

async function connectOne(
  context: BrowserContext,
  origin: string,
  email: string,
  s: Secrets,
): Promise<'saved' | 'skipped'> {
  const page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  const password = email.startsWith('maya@') ? s.mayaPassword : s.demoPassword;
  if (!password) throw new StopError(`${email} needs ~/two-key-secrets/maya-password.txt`);
  await signInToTwoKey(page, origin, email, password);
  console.log(`${email}: signed in`);

  await page.goto(`${origin}/onboarding/paypal`);
  const connect = page.getByRole('button', { name: /^Connect (a different )?PayPal/ });
  await connect.waitFor({ state: 'visible', timeout: FIRST_LOAD_TIMEOUT_MS });
  // "Saved" above "Connect a different PayPal account": the wallet is already active.
  if (
    await page
      .getByText(SAVED_TEXT)
      .isVisible()
      .catch(() => false)
  ) {
    console.log(`${email}: already has an active wallet, skipped`);
    return 'skipped';
  }
  await connect.click();
  await loginToSandbox(page, email, s.buyerEmail, s.buyerPassword);
  console.log(`${email}: logged in to the PayPal sandbox`);

  await approve(page, email, origin);
  await page.getByText(SAVED_TEXT).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log(`${email}: Saved`);
  return 'saved';
}

async function main() {
  const { values } = parseArgs({
    options: { only: { type: 'string', multiple: true }, origin: { type: 'string' } },
  });
  const origin = new URL(values.origin ?? DEFAULT_ORIGIN).origin;
  if (!origin.startsWith('https://')) throw new StopError('origin must be https');
  let accounts: string[];
  try {
    accounts = values.only?.length ? parseDemoAccounts(values.only.join(',')) : DEMO_EMAILS;
  } catch (err) {
    throw new StopError(err instanceof Error ? err.message : String(err));
  }
  const secrets = readSecrets();

  const browser = await chromium.launch({ channel: 'msedge', headless: false });
  const saved: string[] = [];
  const skipped: string[] = [];
  try {
    for (const email of accounts) {
      // A fresh context per account: no cookies or PayPal session carry over.
      const context = await browser.newContext();
      await context.route('**/*', (route) => {
        const host = new URL(route.request().url()).hostname;
        return isLivePayPal(host) ? route.abort('blockedbyclient') : route.continue();
      });
      try {
        const result = await connectOne(context, origin, email, secrets);
        (result === 'saved' ? saved : skipped).push(email);
        await context.close();
      } catch (err) {
        const msg = redact(err instanceof Error ? err.message : String(err));
        console.error(`${email}: stopped — ${msg}`);
        console.log(`saved: ${saved.join(', ') || 'none'}`);
        process.exitCode = 1;
        if (err instanceof WaitError) {
          // Nothing for a person to do in the window: close it and exit.
          await browser.close();
          return;
        }
        console.error('The window is left open. Close it (Ctrl-C) when done.');
        await new Promise(() => undefined); // keep the window for a human
      }
    }
  } finally {
    if (process.exitCode !== 1) await browser.close();
  }
  console.log(
    `saved: ${saved.join(', ') || 'none'}; already active: ${skipped.join(', ') || 'none'}`,
  );
  console.log('Next: npm run demo:setup -- --env prod');
}

main().catch((err) => {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  console.error(redact(err instanceof StopError ? err.message : msg));
  process.exit(1);
});
