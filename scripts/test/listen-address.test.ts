import { type ChildProcess, spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, testDatabaseUrl } from '@twokey/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Render injects PORT and finds a web service only if it listens on 0.0.0.0. Each test starts a
// service's real entry point (what `npm run start` runs) with PORT set and HOST unset, and checks
// where it is listening. Children get an explicit env, never this process's (which may hold
// .env.gateway), and services with a database get a throwaway one.

const root = fileURLToPath(new URL('../../', import.meta.url));
const baseUrl = testDatabaseUrl();
const STARTUP_MS = 60_000;

const children: ChildProcess[] = [];

afterEach(() => {
  for (const c of children.splice(0)) c.kill();
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

/** Only what a child needs to run; HOST deliberately absent. */
function baseEnv(port: number): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, NODE_ENV: 'production', LOG_LEVEL: 'info', PORT: String(port) };
}

/** Starts an entry point and resolves with the address from its "listening" log line. */
function start(entry: string, env: NodeJS.ProcessEnv): Promise<{ host: string; port: number }> {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: root, env });
  children.push(child);
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no "listening" line within ${STARTUP_MS} ms:\n${out.slice(-2000)}`)),
      STARTUP_MS,
    );
    const onData = (d: Buffer) => {
      out += d.toString();
      for (const line of out.split('\n')) {
        try {
          const j = JSON.parse(line) as { msg?: string; host?: string; port?: number };
          if (j.msg === 'listening' && typeof j.host === 'string' && typeof j.port === 'number') {
            clearTimeout(timer);
            resolve({ host: j.host, port: j.port });
            return;
          }
        } catch {
          // not a log line
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`exited with ${code} before listening:\n${out.slice(-2000)}`));
    });
  });
}

/** A non-loopback IPv4 address of this machine: reachable only if the server bound 0.0.0.0. */
function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return undefined;
}

function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host, port });
    s.setTimeout(3000);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
    s.once('timeout', () => {
      s.destroy();
      resolve(false);
    });
  });
}

async function expectAllInterfaces(addr: { host: string; port: number }, port: number) {
  expect(addr).toEqual({ host: '0.0.0.0', port });
  const lan = lanAddress();
  if (lan) expect(await connects(lan, port)).toBe(true);
}

describe('services listen on 0.0.0.0:PORT', () => {
  it(
    'twokey-mcp',
    async () => {
      const port = await freePort();
      const addr = await start('apps/mcp/src/index.ts', {
        ...baseEnv(port),
        GATEWAY_URL: 'http://127.0.0.1:9',
      });
      await expectAllInterfaces(addr, port);
    },
    STARTUP_MS + 10_000,
  );

  describe.skipIf(!baseUrl)('with a throwaway database', () => {
    let dbUrl = '';
    let drop = async () => {};

    beforeAll(async () => {
      ({ url: dbUrl, drop } = await createTestDatabase(baseUrl as string));
    });

    afterAll(async () => {
      for (const c of children.splice(0)) c.kill();
      await drop();
    });

    it(
      'agent-runner',
      async () => {
        const port = await freePort();
        const addr = await start('apps/agent-runner/src/index.ts', {
          ...baseEnv(port),
          DATABASE_URL: dbUrl,
          MCP_URL: 'http://127.0.0.1:9/mcp',
        });
        await expectAllInterfaces(addr, port);
      },
      STARTUP_MS + 10_000,
    );

    it(
      'gateway',
      async () => {
        const port = await freePort();
        const { publicKey } = generateKeyPairSync('ed25519');
        const addr = await start('apps/gateway/src/server.ts', {
          ...baseEnv(port),
          DATABASE_URL: dbUrl,
          PAYPAL_ENV: 'sandbox',
          PAYPAL_CLIENT_ID: 'test-client',
          PAYPAL_CLIENT_SECRET: 'test-secret',
          RULE_HMAC_KEY: Buffer.alloc(32, 1).toString('base64'),
          RULE_HMAC_KEY_ID: 'test-key',
          HUMAN_ASSERTION_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          AGENT_TOKEN_PEPPER: 'test-pepper',
          VAPID_PUBLIC_KEY: 'test-vapid-public',
          VAPID_PRIVATE_KEY: 'test-vapid-private',
          WEB_ORIGIN: 'http://localhost:3000',
          PUBLIC_BASE_URL: 'http://localhost:4000',
        });
        await expectAllInterfaces(addr, port);
      },
      STARTUP_MS + 10_000,
    );
  });
});
