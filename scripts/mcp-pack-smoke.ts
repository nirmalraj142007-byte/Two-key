/**
 * npm run mcp:pack-smoke — the drop-in path, as a stranger would run it.
 *
 * Packs @twokey/mcp, runs the tarball with `npx` from an empty temp folder (so nothing resolves
 * from this workspace), with TWOKEY_AGENT_TOKEN for a fresh demo session on the local gateway,
 * and lists its tools over stdio. Read-only: it calls get_active_rules, never propose_purchase.
 * Needs the dev gateway (npm run dev) and local Postgres.
 */
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:4000';
const EMAIL = 'e2e@twokey.demo';
const EXPECTED = ['get_active_rules', 'get_purchase_status', 'propose_purchase', 'search_products'];
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const dir = mkdtempSync(join(tmpdir(), 'twokey-mcp-pack-'));
try {
  execSync(`npm pack -w @twokey/mcp --pack-destination "${dir}"`, { stdio: 'ignore' });
  const tarball = readdirSync(dir).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack wrote no tarball');
  console.log(`packed ${tarball}`);

  const assertion = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/mint-assertion.ts', EMAIL, 'sessions:create'],
    { encoding: 'utf8' },
  ).trim();
  const res = await fetch(`${GATEWAY}/human/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${assertion}` },
    body: JSON.stringify({ mode: 'demo', model: 'pack-smoke' }),
  });
  if (!res.ok) throw new Error(`POST /human/sessions failed: ${res.status}`);
  const { token } = (await res.json()) as { token: string };

  const transport = new StdioClientTransport({
    command: npx,
    args: ['-y', `./${tarball}`],
    cwd: dir,
    env: {
      ...(process.env as Record<string, string>),
      TWOKEY_AGENT_TOKEN: token,
      GATEWAY_URL: GATEWAY,
    },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'mcp-pack-smoke', version: '0.0.0' });
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    console.log(`tools (${names.length}): ${names.join(', ')}`);
    if (names.join() !== EXPECTED.join())
      throw new Error(`expected exactly ${EXPECTED.join(', ')}`);
    const rules = await client.callTool({ name: 'get_active_rules', arguments: {} });
    console.log(`get_active_rules: ${rules.isError ? 'error' : 'ok'}`);
    if (rules.isError) throw new Error('get_active_rules failed through the tarball');
    console.log('PASS: the packed tarball runs with npx and talks to the gateway');
  } finally {
    await client.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
