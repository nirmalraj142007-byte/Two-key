/**
 * npm run smoke -- --env prod|local
 *
 * Read-only checks against a running Two-Key: every service's health check, the gateway's deep
 * check, the public results and hijack endpoints, and MCP tools/list over Streamable HTTP.
 * Prints a checklist and exits 1 if any check fails. It never proposes, captures or signs
 * anything.
 *
 *   prod   base URLs from SMOKE_WEB_URL, SMOKE_GATEWAY_URL, SMOKE_MCP_URL, SMOKE_RUNNER_URL
 *          (no trailing slash). All four are required.
 *   local  the development stack (3000/4000/4100/4200); each SMOKE_*_URL overrides one.
 *
 * SMOKE_AGENT_TOKEN (tk_agent_…, from /onboarding/agent) is used for tools/list. It is sent
 * only to the MCP URL and never printed.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const EXPECTED_TOOLS = [
  'get_active_rules',
  'get_purchase_status',
  'propose_purchase',
  'search_products',
];
const TIMEOUT_MS = 20_000;

const LOCAL = {
  web: 'http://localhost:3000',
  gateway: 'http://localhost:4000',
  mcp: 'http://localhost:4100',
  runner: 'http://localhost:4200',
};

type Base = typeof LOCAL;

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export function resolveBases(
  env: 'prod' | 'local',
  source: Record<string, string | undefined> = process.env,
): Base {
  const pick = (key: string, fallback: string | undefined): string => {
    const value = source[key]?.trim() || fallback;
    if (!value) throw new Error(`${key} is not set (required for --env ${env})`);
    return value.replace(/\/+$/, '');
  };
  const fallback = env === 'local' ? LOCAL : undefined;
  return {
    web: pick('SMOKE_WEB_URL', fallback?.web),
    gateway: pick('SMOKE_GATEWAY_URL', fallback?.gateway),
    mcp: pick('SMOKE_MCP_URL', fallback?.mcp),
    runner: pick('SMOKE_RUNNER_URL', fallback?.runner),
  };
}

async function getJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON; keep the text for the detail line.
  }
  return { status: res.status, body };
}

async function check(name: string, run: () => Promise<string>): Promise<CheckResult> {
  try {
    return { name, ok: true, detail: await run() };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function expect200(status: number, body: unknown): void {
  if (status !== 200) throw new Error(`HTTP ${status} ${JSON.stringify(body).slice(0, 200)}`);
}

function healthCheck(label: string, url: string): Promise<CheckResult> {
  return check(`${label} ${new URL(url).pathname}`, async () => {
    const { status, body } = await getJson(url);
    expect200(status, body);
    const commit = (body as { commit?: string }).commit;
    return commit ? `commit ${commit.slice(0, 7)}` : 'ok';
  });
}

export async function runSmoke(
  env: 'prod' | 'local',
  bases: Base,
  agentToken: string | undefined,
): Promise<CheckResult[]> {
  const mcpEndpoint = `${bases.mcp}/mcp`;
  const checks: Promise<CheckResult>[] = [
    healthCheck('web', `${bases.web}/api/healthz`),
    healthCheck('gateway', `${bases.gateway}/healthz`),
    healthCheck('twokey-mcp', `${bases.mcp}/healthz`),
    healthCheck('agent-runner', `${bases.runner}/healthz`),
    check('gateway /healthz/deep', async () => {
      const { status, body } = await getJson(`${bases.gateway}/healthz/deep`);
      const deep = body as { db?: string; paypalAuth?: string; webhookSubscriptions?: string };
      // Locally no webhook is registered (PUBLIC_BASE_URL is localhost); production must have one.
      const localWithoutWebhook =
        env === 'local' &&
        status === 503 &&
        deep.db === 'ok' &&
        deep.paypalAuth === 'ok' &&
        deep.webhookSubscriptions === 'not_configured';
      if (!localWithoutWebhook) expect200(status, body);
      return `${JSON.stringify(body)}${localWithoutWebhook ? ' (no webhook locally: ok)' : ''}`;
    }),
    check('web /api/results/summary', async () => {
      const { status, body } = await getJson(`${bases.web}/api/results/summary`);
      expect200(status, body);
      const split = (body as { split?: string }).split;
      return split ? `split ${split}` : 'ok';
    }),
    check('web /api/hijack/status', async () => {
      const { status, body } = await getJson(`${bases.web}/api/hijack/status`);
      expect200(status, body);
      const b = body as { live?: boolean; attemptsLeftToday?: number };
      return `live ${String(b.live)}, attempts left today ${String(b.attemptsLeftToday)}`;
    }),
    check('twokey-mcp rejects a missing agent token', async () => {
      const { status } = await getJson(mcpEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      if (status !== 401) throw new Error(`expected 401, got ${status}`);
      return '401';
    }),
    check('twokey-mcp tools/list (Streamable HTTP)', async () => {
      if (!agentToken) throw new Error('SMOKE_AGENT_TOKEN is not set');
      const client = new Client({ name: 'twokey-smoke', version: '0.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(mcpEndpoint), {
          requestInit: { headers: { authorization: `Bearer ${agentToken}` } },
        }),
      );
      try {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name).sort();
        if (names.join(',') !== EXPECTED_TOOLS.join(',')) {
          throw new Error(`tools are ${names.join(', ')}; expected ${EXPECTED_TOOLS.join(', ')}`);
        }
        return names.join(', ');
      } finally {
        await client.close();
      }
    }),
  ];
  return Promise.all(checks);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { env: { type: 'string', default: 'prod' } } });
  if (values.env !== 'prod' && values.env !== 'local') {
    console.error('usage: npm run smoke -- --env prod|local');
    process.exit(2);
  }
  let bases: Base;
  try {
    bases = resolveBases(values.env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  console.log(`Two-Key smoke (${values.env}) ${new Date().toISOString()}`);
  for (const [k, v] of Object.entries(bases)) console.log(`  ${k.padEnd(8)} ${v}`);
  const results = await runSmoke(
    values.env,
    bases,
    process.env.SMOKE_AGENT_TOKEN?.trim() || undefined,
  );
  for (const r of results) console.log(`[${r.ok ? 'x' : ' '}] ${r.name}: ${r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failed} of ${results.length})`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
