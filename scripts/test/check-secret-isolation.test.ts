import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../check-secret-isolation.ts', import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function run(file: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', script, file], { encoding: 'utf8' });
}

describe('check-secret-isolation', () => {
  it('passes a clean blueprint', () => {
    const r = run(fixture('clean.yaml'));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('secret isolation OK (4 services)');
  });

  it('fails when web carries PAYPAL_CLIENT_SECRET', () => {
    const r = run(fixture('web-with-paypal-secret.yaml'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('PAYPAL_CLIENT_SECRET may only be set on: gateway (found on web)');
  });

  it('passes the real render.yaml', () => {
    expect(run(fileURLToPath(new URL('../../render.yaml', import.meta.url))).status).toBe(0);
  });
});
