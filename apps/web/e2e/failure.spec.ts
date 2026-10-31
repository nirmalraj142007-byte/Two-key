import { expect, test } from '@playwright/test';
import { runScripted, sandboxLogin, signIn } from './sandbox';

// The two failure paths, on the real PayPal sandbox (see happy.spec.ts for the setup). A blocked
// proposal makes no PayPal call; a held one is a real authorization that Deny voids.

test.beforeAll(() => {
  sandboxLogin();
});

test('scripted:attack -> Blocked, and History shows no PayPal IDs', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const card = await runScripted(page, 'attack');
  const proposalId = await card.getAttribute('data-proposal-id');
  expect(proposalId).toBeTruthy();

  await expect(card.locator('[data-slot="state-badge"]')).toHaveText('Blocked · no PayPal order', {
    timeout: 60_000,
  });
  await expect(card).toContainText('Digital gift card $189');
  await expect(card.locator('[data-slot="paypal-id"]')).toHaveCount(0);

  // History: the row exists, is blocked, and carries no PayPal order, authorization or capture.
  const res = await page.request.get('/api/history');
  expect(res.status()).toBe(200);
  const { rows } = (await res.json()) as {
    rows: {
      proposalId: string;
      state: string;
      paymentId: string | null;
      orderId: string | null;
      authorizationId: string | null;
      captureId: string | null;
    }[];
  };
  const row = rows.find((r) => r.proposalId === proposalId);
  expect(row, 'the blocked proposal is in History').toBeDefined();
  expect(row).toMatchObject({
    state: 'blocked',
    paymentId: null,
    orderId: null,
    authorizationId: null,
    captureId: null,
  });
  await page.goto('/history');
  await expect(page.getByTestId('history-grid')).toBeVisible();
  await expect(page.getByText('No PayPal order created.').first()).toBeVisible({ timeout: 30_000 });
});

test('scripted:anomaly -> held, Deny on the phone page -> Voided · no charge', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const card = await runScripted(page, 'anomaly');
  const proposalId = await card.getAttribute('data-proposal-id');
  expect(proposalId).toBeTruthy();
  await expect(card.locator('[data-slot="state-badge"]')).toHaveText('Waiting for you', {
    timeout: 60_000,
  });
  await expect(card).toContainText('Trail Runner TR-2');

  // The card links to the hold; the phone page takes the same approval ID.
  const href = await card.locator('a[href^="/approvals/"]').getAttribute('href');
  const approvalId = href?.split('/').pop();
  expect(approvalId, 'the held card links to its approval').toBeTruthy();
  await page.goto(`/m/approve/${approvalId}`);
  const approval = page.locator('[data-slot="approval-card"]');
  await expect(approval).toBeVisible();
  await approval.getByRole('button', { name: 'Deny' }).click();
  await expect(approval.locator('[data-slot="state-badge"]')).toHaveText('Voided · no charge', {
    timeout: 60_000,
  });
});
