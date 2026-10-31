/**
 * Writes .env.gateway, .env.web, .env.mcp and .env.agent-runner for the e2e-sandbox workflow,
 * plus spikes/results/vault.json (the saved wallet e2e:purchase attaches to e2e@twokey.demo).
 *
 *   CI=true npm run ci:sandbox-env
 *
 * The PayPal sandbox credentials and the vaulted wallet come from repository secrets (read from
 * the environment, never printed). Everything else is generated for this run: the keys only have
 * to match each other, and the database is the job's own throwaway Postgres. Refuses to run
 * outside CI so it can never overwrite a developer's own .env files. OUT_DIR (default: the
 * repository root) lets the output go elsewhere.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import webpush from 'web-push';

if (process.env.CI !== 'true') {
  console.error('ci:sandbox-env only runs in CI (CI=true): it writes the .env.<service> files.');
  process.exit(1);
}

const REQUIRED = [
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'MERCHANT_API_CREDENTIALS',
  'E2E_VAULT_PAYMENT_TOKEN_ID',
  'E2E_VAULT_CUSTOMER_ID',
] as const;
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing repository secrets: ${missing.join(', ')}`);
  process.exit(1);
}
const secret = (name: (typeof REQUIRED)[number]) => process.env[name] ?? '';

const out = process.env.OUT_DIR ?? fileURLToPath(new URL('..', import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://twokey:twokey@localhost:5432/twokey';
const rand = (n = 32) => randomBytes(n).toString('base64url');
const pem = (name: string, value: string) => `${name}="${value.trim()}"`;

const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
const vapid = webpush.generateVAPIDKeys();
const demoPassword = rand(18);

const files: Record<string, string[]> = {
  '.env.gateway': [
    `DATABASE_URL=${DATABASE_URL}`,
    'PAYPAL_ENV=sandbox',
    `PAYPAL_CLIENT_ID=${secret('PAYPAL_CLIENT_ID')}`,
    `PAYPAL_CLIENT_SECRET=${secret('PAYPAL_CLIENT_SECRET')}`,
    `MERCHANT_API_CREDENTIALS=${secret('MERCHANT_API_CREDENTIALS')}`,
    `RULE_HMAC_KEY=${randomBytes(32).toString('base64')}`,
    'RULE_HMAC_KEY_ID=ci',
    pem('HUMAN_ASSERTION_PUBLIC_KEY', await exportSPKI(publicKey)),
    `AGENT_TOKEN_PEPPER=${rand()}`,
    `VAPID_PUBLIC_KEY=${vapid.publicKey}`,
    `VAPID_PRIVATE_KEY=${vapid.privateKey}`,
    'WEB_ORIGIN=http://localhost:3000',
    'PUBLIC_BASE_URL=http://localhost:4000',
    `DEMO_PASSWORD=${demoPassword}`,
    'DEMO_HOLD_MINUTES=15',
  ],
  '.env.web': [
    `DATABASE_URL=${DATABASE_URL}`,
    `AUTH_SECRET=${rand()}`,
    pem('HUMAN_ASSERTION_PRIVATE_KEY', await exportPKCS8(privateKey)),
    'GATEWAY_URL=http://localhost:4000',
    'WEB_ORIGIN=http://localhost:3000',
    `IP_HASH_SALT=${rand()}`,
    `NEXT_PUBLIC_VAPID_PUBLIC_KEY=${vapid.publicKey}`,
    'AUTH_TRUST_HOST=true',
  ],
  '.env.mcp': ['GATEWAY_URL=http://localhost:4000'],
  '.env.agent-runner': [
    `DATABASE_URL=${DATABASE_URL}`,
    'MCP_URL=http://localhost:4100/mcp',
    'GATEWAY_URL=http://localhost:4000',
  ],
};

for (const [name, lines] of Object.entries(files)) {
  writeFileSync(join(out, name), `${lines.join('\n')}\n`, { mode: 0o600 });
}
mkdirSync(join(out, 'spikes', 'results'), { recursive: true });
writeFileSync(
  join(out, 'spikes', 'results', 'vault.json'),
  JSON.stringify({
    paymentTokenId: secret('E2E_VAULT_PAYMENT_TOKEN_ID'),
    customerId: secret('E2E_VAULT_CUSTOMER_ID'),
  }),
  { mode: 0o600 },
);
console.log(`Wrote ${Object.keys(files).join(', ')} and spikes/results/vault.json`);
