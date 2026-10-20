import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '@twokey/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));

// A complete, valid gateway env built from scratch (nothing inherited from .env.gateway
// except the database server). Booting starts the job workers and a sweep, so the gateway gets
// a throwaway database of its own: never the dev database. PayPal values are dummies.
const env: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  PAYPAL_ENV: 'sandbox',
  PAYPAL_CLIENT_ID: 'dummy-client-id',
  PAYPAL_CLIENT_SECRET: 'dummy-client-secret',
  PAYPAL_WEBHOOK_ID: 'WH-DUMMY',
  RULE_HMAC_KEY: Buffer.alloc(32, 7).toString('base64'),
  RULE_HMAC_KEY_ID: 'k1',
  HUMAN_ASSERTION_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----',
  AGENT_TOKEN_PEPPER: 'pepper',
  VAPID_PUBLIC_KEY: 'pub',
  VAPID_PRIVATE_KEY: 'priv',
  WEB_ORIGIN: 'http://localhost:3000',
  PUBLIC_BASE_URL: 'http://localhost:4000',
};

/** A port that was free a moment ago (the env schema rejects PORT=0). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject()));
    });
  });
}

const baseUrl = process.env.DATABASE_URL || 'postgres://twokey:twokey@localhost:5432/twokey';
let drop = async () => {};
beforeAll(async () => {
  let url: string;
  ({ url, drop } = await createTestDatabase(baseUrl));
  env.DATABASE_URL = url;
});
afterAll(async () => {
  await drop();
});

let child: ChildProcessWithoutNullStreams | undefined;
afterEach(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});

/** Resolves with the URL from Fastify's "Server listening at ..." log line. */
function waitForListening(p: ChildProcessWithoutNullStreams, output: () => string) {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listen log:\n${output()}`)), 20_000);
    p.stdout.on('data', () => {
      const m = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output());
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    p.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(`gateway exited before listening:\n${output()}`));
    });
  });
}

describe('gateway boot', () => {
  it('starts, serves /healthz, stays up and shuts down cleanly', { timeout: 40_000 }, async () => {
    const port = await freePort();
    const p = spawn(process.execPath, ['--import', 'tsx', SERVER], {
      cwd: ROOT,
      env: { ...env, PORT: String(port) },
    });
    child = p;
    let out = '';
    p.stdout.setEncoding('utf8').on('data', (d: string) => {
      out += d;
    });
    p.stderr.setEncoding('utf8').on('data', (d: string) => {
      out += d;
    });
    const exited = new Promise<number | null>((resolve) => p.on('exit', (code) => resolve(code)));

    const base = await waitForListening(p, () => out);
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: 'gateway' });

    await sleep(3_000);
    expect(p.exitCode, out).toBeNull();
    expect(out).not.toContain('startup failed');
    expect(out).toContain('jobs started');

    p.kill('SIGTERM');
    const code = await exited;
    // Windows can't deliver SIGTERM to a handler (the child is terminated outright), so the
    // clean-exit assertion only holds on POSIX, which is where CI and Render run.
    if (process.platform !== 'win32') expect(code, out).toBe(0);
  });
});
