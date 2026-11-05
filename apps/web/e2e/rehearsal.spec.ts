import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { signIn } from './sandbox';

// Phase 33 rehearsal: walks every beat of docs/VIDEO.md on the LOCAL stack at 1280x720, as the
// runbook says, including the scripted fallbacks, and saves what the camera would see to
// docs/evidence/rehearsal/. Spends PayPal sandbox money and one live model run:
//   E2E_SANDBOX=1 E2E_USER=maya@twokey.demo PLAYWRIGHT_CHANNEL=msedge \
//     npx playwright test e2e/rehearsal.spec.ts -c apps/web

const root = join(__dirname, '..', '..', '..');
const OUT = join(root, 'docs', 'evidence', 'rehearsal');
const DEMO_REQUEST =
  'Running shoes, size 10, under $70, only Stride Supply or Peak Outfitters, one pair, this week.';

test.use({ viewport: { width: 1280, height: 720 } });
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

let page: Page;

test.beforeAll(async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await signIn(page);
});

test.afterAll(async () => {
  await page?.close();
});

async function settle(p: Page) {
  await p.waitForLoadState('load');
  await p.locator('main').first().waitFor({ state: 'visible', timeout: 60_000 });
  await p.waitForTimeout(1_200);
  // The Next.js dev badge is not part of the product.
  await p.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

const shot = (name: string) => page.screenshot({ path: join(OUT, `${name}.png`) });

/** Sends the message and returns the newest proposal card once it reaches a final-ish state. */
async function run(message: string, model?: string) {
  await page.goto(model ? `/agent?model=${model}` : '/agent');
  await settle(page);
  if (model) {
    await expect(page.locator('[data-slot="scripted-run-label"]')).toContainText(model);
  }
  await page.getByLabel('What should the agent buy?').fill(message);
  await page.getByRole('button', { name: 'Send to agent' }).click();
  const card = page.locator('[data-slot="proposal-card"]').first();
  await expect(card).toBeVisible({ timeout: 120_000 });
  return card;
}

async function denyFirstHold(name: string) {
  await page.goto('/approvals');
  await settle(page);
  await shot(`${name}-approvals`);
  const deny = page.getByRole('button', { name: 'Deny' }).first();
  await expect(deny).toBeVisible({ timeout: 30_000 });
  await deny.click();
  await page.waitForTimeout(800);
  await shot(`${name}-denying`);
  await expect(page.getByText(/Voided|Denied|no charge/i).first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1_000);
  await shot(`${name}-voided`);
}

test('0:00 hook, live model', async () => {
  const card = await run(DEMO_REQUEST).catch(() => null);
  await page.waitForTimeout(2_000);
  await shot('01-hook-live');
  // The transcript's tagged listing, scrolled into frame if the model searched.
  const tag = page.getByText(/This attack text fooled/).first();
  if (await tag.isVisible().catch(() => false)) {
    await tag.scrollIntoViewIfNeeded();
    await shot('01b-hook-live-tag');
  }
  if (card) {
    await expect(card).toContainText(/Waiting for you|Blocked|Captured|Voided|authoriz/i, {
      timeout: 120_000,
    });
    await shot('01c-hook-live-card');
  }
});

test('0:00 hook, scripted fallback', async () => {
  const card = await run(DEMO_REQUEST, 'scripted:hook');
  await page.waitForTimeout(400);
  await shot('02a-hook-scripted-running');
  await expect(card).toContainText('Trail Runner TR-2');
  await expect(card).toContainText('Waiting for you', { timeout: 60_000 });
  await shot('02b-hook-scripted-held');
  const tag = page.getByText(/This attack text fooled all 3 models in our test \(goal adapted\)/);
  await expect(tag.first()).toBeVisible();
  await tag.first().scrollIntoViewIfNeeded();
  await shot('02c-hook-scripted-tag');
});

test('0:10 rules card', async () => {
  // There is no /rules index: the console's "See all rules" link opens the signed card.
  await page.goto('/agent');
  await settle(page);
  await page.getByRole('link', { name: 'See all rules' }).click();
  await page.waitForURL(/\/rules\/[0-9a-f-]+$/);
  await settle(page);
  await shot('03a-rules');
  // The other badge the beat needs: "size 10" is the agent's job, below the fold at 720.
  await page
    .getByText(/Agent.s job/)
    .first()
    .scrollIntoViewIfNeeded();
  await shot('03b-rules-agents-job');
});

test('0:20 clean purchase', async () => {
  const card = await run(DEMO_REQUEST, 'scripted:happy');
  await page.waitForTimeout(400);
  await shot('04a-clean-running');
  await expect(card).toContainText('Captured', { timeout: 90_000 });
  await shot('04b-clean-captured');
  await page.goto('/history');
  await settle(page);
  await shot('05-history');
});

test('0:32 attacker attempt', async () => {
  const card = await run(DEMO_REQUEST, 'scripted:attack');
  await expect(card).toContainText('Blocked', { timeout: 60_000 });
  await page.waitForTimeout(600);
  await shot('06-attack-blocked');
});

test('0:50 hold: deny in /approvals (no-push fallback)', async () => {
  await denyFirstHold('07-hold');
});

test('0:50 hold, scripted:anomaly fallback', async () => {
  const card = await run('Trail Runner TR-2, under $70, one pair.', 'scripted:anomaly');
  await expect(card).toContainText('Waiting for you', { timeout: 60_000 });
  await shot('08a-anomaly-held');
  await denyFirstHold('08b-anomaly');
});

test('1:10 results', async () => {
  await page.goto('/results');
  await settle(page);
  await shot('09-results');
});

test('1:40 honesty: frontier and predictions', async () => {
  await page.goto('/results');
  await settle(page);
  await page.getByRole('tab', { name: 'Frontier' }).click();
  await page.waitForTimeout(1_000);
  await page.getByText('The trade-off frontier').scrollIntoViewIfNeeded();
  await shot('10-frontier');
  await page.getByRole('tab', { name: 'Predictions' }).click();
  await page.waitForTimeout(1_000);
  await page.getByRole('tab', { name: 'Predictions' }).scrollIntoViewIfNeeded();
  await shot('11-predictions');
});

test('2:00 MCP: developers page', async () => {
  await page.goto('/developers');
  await settle(page);
  await shot('12-developers');
});

test('2:20 AP2', async () => {
  await page.goto('/about');
  await settle(page);
  await page
    .getByText(/Agent Payments Protocol|AP2/)
    .first()
    .scrollIntoViewIfNeeded();
  await shot('13-about-ap2');
});

test('2:35 hijack box', async () => {
  await page.goto('/hijack');
  await settle(page);
  await shot('14-hijack');
});
