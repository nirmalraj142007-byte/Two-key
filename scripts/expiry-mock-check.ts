/**
 * Phase 9: what does a capture on an expired authorization look like? Against the REAL sandbox:
 *
 *   npm run spike:expiry
 *
 * 1. Creates a vaulted AUTHORIZE order with the wallet in spikes/results/vault.json ($1.00, Stride Supply).
 * 2. Captures it with PayPal's negative-testing header
 *    PayPal-Mock-Response: {"mock_application_codes":"AUTHORIZATION_EXPIRED"}.
 * 3. Voids the authorization (whatever step 2 returned, so nothing stays open).
 *
 * Appends exactly what PayPal returned to docs/SPIKE_RESULTS.md. Prints no tokens or vault IDs.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { createLogger, loadEnv } from '@twokey/core';
import { createPayPal } from '@twokey/paypal';
import { z } from 'zod';

const ROOT = new URL('../', import.meta.url);
const env = loadEnv('gateway');
// The env schema only allows PAYPAL_ENV=sandbox.
const BASE = 'https://api-m.sandbox.paypal.com';

const vault = z
  .object({ paymentTokenId: z.string().min(1) })
  .parse(JSON.parse(readFileSync(new URL('spikes/results/vault.json', ROOT), 'utf8')));
const stride = z
  .array(z.object({ slug: z.string(), paypalMerchantId: z.string() }))
  .parse(JSON.parse(readFileSync(new URL('config/merchants.json', ROOT), 'utf8')))
  .find((m) => m.slug === 'stride-supply');
if (!stride) throw new Error('config/merchants.json has no stride-supply');

const pp = createPayPal({
  clientId: env.PAYPAL_CLIENT_ID,
  clientSecret: env.PAYPAL_CLIENT_SECRET,
  env: env.PAYPAL_ENV,
  logger: createLogger('gateway', 'warn'),
});

async function accessToken(): Promise<string> {
  const basic = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString(
    'base64',
  );
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const json = (await res.json()) as { access_token?: string };
  if (!res.ok || !json.access_token) throw new Error(`OAuth failed: HTTP ${res.status}`);
  return json.access_token;
}

const run = randomUUID();
const MOCK = JSON.stringify({ mock_application_codes: 'AUTHORIZATION_EXPIRED' });

// 1. Vaulted authorization.
const auth = await pp.createVaultedAuthorization({
  requestId: `tk-spike-expiry-${run}-create`,
  vaultId: vault.paymentTokenId,
  payeeMerchantId: stride.paypalMerchantId,
  referenceId: run,
  amountCents: 100,
  item: { name: 'Expiry mock check', sku: 'spike-expiry', qty: 1, unitAmountCents: 100 },
});
console.log(
  `1. authorization ${auth.authorizationId} (order ${auth.orderId}) status ${auth.authorizationStatus}`,
);

// 2. Capture with the mock header (raw fetch: the SDK has no slot for extra headers).
const token = await accessToken();
const res = await fetch(`${BASE}/v2/payments/authorizations/${auth.authorizationId}/capture`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    prefer: 'return=representation',
    'paypal-request-id': `tk-spike-expiry-${run}-capture`,
    'paypal-mock-response': MOCK,
  },
  body: JSON.stringify({ final_capture: true }),
});
const text = await res.text();
let body: Record<string, unknown> = {};
try {
  body = JSON.parse(text) as Record<string, unknown>;
} catch {
  body = { raw: text.slice(0, 500) };
}
const issues = Array.isArray(body.details)
  ? (body.details as Array<{ issue?: string; description?: string }>)
  : [];
const debugId = (body.debug_id as string | undefined) ?? res.headers.get('paypal-debug-id') ?? '';
const issueList = issues.map((d) => d.issue).filter(Boolean);
console.log(
  `2. capture with PayPal-Mock-Response ${MOCK}: HTTP ${res.status} ` +
    `name=${String(body.name ?? '')} status=${String(body.status ?? '')} ` +
    `issues=${issueList.join(',') || '-'} debug_id=${debugId}`,
);
for (const d of issues) console.log(`   ${d.issue}: ${d.description ?? ''}`);

const supported = res.status === 422 && issueList.includes('AUTHORIZATION_EXPIRED');
const outcome = supported
  ? 'expired'
  : res.status < 300
    ? 'mock ignored: the capture SUCCEEDED'
    : 'mock not supported as AUTHORIZATION_EXPIRED';
console.log(`   => ${outcome}`);

// 3. Void, so nothing stays open (a captured authorization can't be voided; that is reported).
let voidResult: string;
try {
  await pp.voidAuthorization({
    authorizationId: auth.authorizationId,
    requestId: `tk-spike-expiry-${run}-void`,
  });
  voidResult = 'VOIDED';
} catch (err) {
  voidResult = err instanceof Error ? err.message : String(err);
}
const after = await pp.getAuthorization(auth.authorizationId).catch(() => undefined);
console.log(`3. void: ${voidResult}; authorization status now ${after?.status ?? 'unknown'}`);

const md = `
## Phase 9 authorization-expiry mock check ${new Date().toISOString().slice(0, 10)}

\`npm run spike:expiry\` (real sandbox): vaulted $1.00 authorization at Stride Supply, then
\`POST /v2/payments/authorizations/{id}/capture\` with
\`PayPal-Mock-Response: ${MOCK}\`.

| Step | Result |
| --- | --- |
| Authorization | ${auth.authorizationId} (order ${auth.orderId}), ${auth.authorizationStatus} |
| Capture with mock header | HTTP ${res.status}, name \`${String(body.name ?? '')}\`, status \`${String(body.status ?? '')}\`, issues \`${issueList.join(', ') || '-'}\`, debug_id \`${debugId}\` |
| Issue descriptions | ${issues.map((d) => `${d.issue}: ${d.description ?? ''}`).join('; ') || '-'} |
| Void afterwards | ${voidResult}; authorization status ${after?.status ?? 'unknown'} |
| Outcome | **${outcome}** |

${
  supported
    ? '- PayPal simulates the expired-authorization capture on this endpoint. The gateway maps it to `expired` with no retry (`captureHeld`), and lifecycle test (6) uses the same body shape.'
    : '- PayPal does not return AUTHORIZATION_EXPIRED for this mock code on this endpoint, so the evidence for the expiry path is the fixture test: `apps/gateway/test/lifecycle.test.ts` (6) with `apps/gateway/test/fixtures/capture-authorization-expired.json`.'
}
`;
appendFileSync(new URL('docs/SPIKE_RESULTS.md', ROOT), md);
console.log('appended to docs/SPIKE_RESULTS.md');
