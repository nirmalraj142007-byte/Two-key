/**
 * Prints a fresh set of LOCAL development keys as env lines, labelled with the owning service:
 *
 *   npm run keys:gen
 *
 * Paste each block into the named .env.<service> file. Never paste these into Render: staging
 * and production keep their own keys, and HUMAN_ASSERTION_PUBLIC_KEY (gateway) must match
 * HUMAN_ASSERTION_PRIVATE_KEY (web) from the same run.
 */
import { randomBytes } from 'node:crypto';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import webpush from 'web-push';

/** PEM values span lines; dotenv reads them inside double quotes. */
function pemLine(name: string, pem: string): string {
  return `${name}="${pem.trim()}"`;
}

const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
const vapid = webpush.generateVAPIDKeys();
const keyId = `local-${new Date().toISOString().slice(0, 10)}`;

const blocks: [string, string[]][] = [
  [
    'gateway (.env.gateway)',
    [
      pemLine('HUMAN_ASSERTION_PUBLIC_KEY', await exportSPKI(publicKey)),
      `RULE_HMAC_KEY=${randomBytes(32).toString('base64')}`,
      `RULE_HMAC_KEY_ID=${keyId}`,
      `AGENT_TOKEN_PEPPER=${randomBytes(32).toString('base64url')}`,
      `VAPID_PUBLIC_KEY=${vapid.publicKey}`,
      `VAPID_PRIVATE_KEY=${vapid.privateKey}`,
    ],
  ],
  [
    'web (.env.web)',
    [
      pemLine('HUMAN_ASSERTION_PRIVATE_KEY', await exportPKCS8(privateKey)),
      `NEXT_PUBLIC_VAPID_PUBLIC_KEY=${vapid.publicKey}`,
    ],
  ],
];

console.log('# LOCAL development keys. Do not use on Render.');
console.log('# Changing RULE_HMAC_KEY invalidates every signed rule card in the local database.\n');
for (const [label, lines] of blocks) {
  console.log(`# ---- ${label} ----`);
  for (const line of lines) console.log(line);
  console.log('');
}
