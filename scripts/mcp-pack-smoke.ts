/**
 * npm run mcp:pack-smoke — the drop-in path, as a stranger would run it.
 *
 * Installs the exact release asset (release/<asset> from `npm run mcp:release`, checked against
 * the sha256 pinned in apps/mcp/release.json) from a copy in an empty temp folder, so nothing
 * resolves from this workspace. With --remote it runs `npx -y <release url>` instead, the same
 * command /developers and docs/claude-desktop.md show, after checking the download's sha256.
 * Then it lists the tools over stdio with TWOKEY_AGENT_TOKEN for a fresh demo session on the local
 * gateway. Read-only: it calls get_active_rules, never propose_purchase.
 * Needs the dev gateway (npm run dev) and local Postgres.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = join(import.meta.dirname, '..');
const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:4000';
const EMAIL = 'e2e@twokey.demo';
const EXPECTED = ['get_active_rules', 'get_purchase_status', 'propose_purchase', 'search_products'];
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const remote = process.argv.includes('--remote');

const release = JSON.parse(readFileSync(join(ROOT, 'apps', 'mcp', 'release.json'), 'utf8')) as {
  asset: string;
  url: string;
  sha256: string;
};
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const dir = mkdtempSync(join(tmpdir(), 'twokey-mcp-pack-'));
try {
  let spec: string;
  if (remote) {
    const res = await fetch(release.url);
    if (!res.ok) throw new Error(`GET ${release.url} failed: ${res.status}`);
    const got = sha256(new Uint8Array(await res.arrayBuffer()));
    if (got !== release.sha256) throw new Error(`release asset sha256 ${got} != ${release.sha256}`);
    spec = release.url;
    console.log(`release asset ${release.url} matches sha256 ${release.sha256}`);
  } else {
    const local = join(ROOT, 'release', release.asset);
    if (!existsSync(local))
      throw new Error(`release/${release.asset} is missing: run npm run mcp:release`);
    const got = sha256(readFileSync(local));
    if (got !== release.sha256)
      throw new Error(`release/${release.asset} sha256 ${got} != ${release.sha256}`);
    copyFileSync(local, join(dir, release.asset));
    spec = `./${release.asset}`;
    console.log(`local copy of release/${release.asset} matches sha256 ${release.sha256}`);
  }

  const assertion = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/mint-assertion.ts', EMAIL, 'sessions:create'],
    { cwd: ROOT, encoding: 'utf8' },
  ).trim();
  const res = await fetch(`${GATEWAY}/human/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${assertion}` },
    body: JSON.stringify({ mode: 'demo', model: 'pack-smoke' }),
  });
  if (!res.ok) throw new Error(`POST /human/sessions failed: ${res.status}`);
  const { token } = (await res.json()) as { token: string };

  console.log(`npx -y ${spec}`);
  const transport = new StdioClientTransport({
    command: npx,
    args: ['-y', spec],
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
    console.log(
      `PASS: ${remote ? 'the release URL' : 'the release tarball'} runs with npx and talks to the gateway`,
    );
  } finally {
    await client.close();
  }
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
