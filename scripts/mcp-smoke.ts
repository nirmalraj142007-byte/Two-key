/**
 * Drives the running MCP server end to end, as an agent would: session -> search -> propose -> status.
 * Uses e2e@twokey.demo (50 purchases per 24 h), so it never trips the frequency rule.
 *
 *   npm run dev & npm run mcp:smoke
 */
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:4000';
const MCP = process.env.MCP_URL ?? 'http://localhost:4100/mcp';
const EMAIL = 'e2e@twokey.demo';

function assertion(): string {
  return execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/mint-assertion.ts', EMAIL, 'sessions:create'],
    { encoding: 'utf8' },
  ).trim();
}

const res = await fetch(`${GATEWAY}/human/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${assertion()}` },
  body: JSON.stringify({ mode: 'demo', model: 'smoke' }),
});
if (!res.ok) throw new Error(`POST /human/sessions failed: ${res.status} ${await res.text()}`);
const { token } = (await res.json()) as { token: string };

const client = new Client({ name: 'mcp-smoke', version: '0.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(MCP), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
);

try {
  const { tools } = await client.listTools();
  console.log(`tools: ${tools.map((t) => t.name).join(', ')}`);

  const search = await client.callTool({
    name: 'search_products',
    arguments: { query: 'cloud runner' },
  });
  const items =
    (search.structuredContent as { items?: { product_id: string; store: string }[] } | undefined)
      ?.items ?? [];
  const pick = items.find((i) => i.store === 'Stride Supply');
  if (!pick) throw new Error(`no Stride Supply result: ${JSON.stringify(search)}`);
  console.log(`search: ${items.length} results, picking ${pick.store} ${pick.product_id}`);

  const propose = await client.callTool({
    name: 'propose_purchase',
    arguments: { product_id: pick.product_id, qty: 1 },
  });
  const decision = propose.structuredContent as { proposalId?: string; decision?: string };
  console.log(`proposal ${decision.proposalId} decision=${decision.decision}`);
  if (!decision.proposalId) throw new Error(`propose failed: ${JSON.stringify(propose)}`);

  await new Promise((r) => setTimeout(r, 5000));
  const status = await client.callTool({
    name: 'get_purchase_status',
    arguments: { proposal_id: decision.proposalId },
  });
  const s = status.structuredContent as { decision?: string; paymentState?: string | null };
  console.log(`status=${s.paymentState ?? s.decision}`);
} finally {
  await client.close();
}
