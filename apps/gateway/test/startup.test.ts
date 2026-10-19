import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));

// A complete gateway env except RULE_HMAC_KEY. Built from scratch so nothing leaks in from
// the test process (vitest loads .env.gateway locally).
const env: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://twokey:twokey@localhost:5432/twokey',
  PAYPAL_ENV: 'sandbox',
  PAYPAL_CLIENT_ID: 'id',
  PAYPAL_CLIENT_SECRET: 'secret',
  RULE_HMAC_KEY_ID: 'k1',
  HUMAN_ASSERTION_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----',
  AGENT_TOKEN_PEPPER: 'pepper',
  VAPID_PUBLIC_KEY: 'pub',
  VAPID_PRIVATE_KEY: 'priv',
  WEB_ORIGIN: 'http://localhost:3000',
  PUBLIC_BASE_URL: 'http://localhost:4000',
  PORT: '0',
};

function run(): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', SERVER], { cwd: ROOT, env });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('gateway startup', () => {
  it('prints the missing key on stderr and exits 1', { timeout: 30_000 }, async () => {
    const { code, stderr } = await run();
    expect(stderr).toContain('startup failed');
    expect(stderr).toContain('RULE_HMAC_KEY');
    expect(stderr).not.toContain('secret'); // key names only, never values
    expect(code).toBe(1);
  });
});
