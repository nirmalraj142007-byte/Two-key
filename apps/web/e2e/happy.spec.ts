import { expect, test } from '@playwright/test';
import { runScripted, sandboxLogin, signIn } from './sandbox';

// Real PayPal sandbox: the scripted agent proposes the clean purchase and Two-Key authorizes and
// captures it on the saved wallet with nobody at checkout. Needs E2E_SANDBOX=1, the local stack
// (npm run dev) and a user with a saved wallet and a signed card (judge1, or E2E_USER).

test.beforeAll(() => {
  sandboxLogin();
});

test('scripted:happy -> the card reads Captured and shows a PayPal capture ID', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const card = await runScripted(page, 'happy');

  await expect(card.locator('[data-slot="state-badge"]')).toHaveText('Captured', {
    timeout: 60_000,
  });
  await expect(card).toContainText('Cloud Runner CR-1');
  await expect(card).toContainText('Stride Supply');
  await expect(
    card.locator('[data-slot="paypal-id"]').filter({ hasText: 'capture ID' }),
  ).toHaveCount(1);
  // The full ID is in the screen-reader text: "PayPal capture ID <id>".
  const text = await card.locator('[data-slot="paypal-id"] .sr-only').allInnerTexts();
  const capture = text.map((t) => t.match(/^PayPal capture ID (\S+)$/)?.[1]).find(Boolean);
  expect(capture).toMatch(/^[A-Z0-9]{10,}$/);
});
