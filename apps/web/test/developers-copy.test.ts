import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_AFTER,
  CONFIG_BEFORE,
  DEMO_TOKEN_NOTE,
  MCP_RELEASE_URL,
  NO_MONEY_TOOLS,
  TOOLS,
} from '../lib/developers-copy';

const doc = readFileSync(new URL('../../../docs/claude-desktop.md', import.meta.url), 'utf8');
const release = JSON.parse(
  readFileSync(new URL('../../mcp/release.json', import.meta.url), 'utf8'),
) as { url: string; sha256: string };

describe('developers copy', () => {
  it('docs/claude-desktop.md carries the same content as /developers', () => {
    for (const part of [CONFIG_BEFORE, CONFIG_AFTER, DEMO_TOKEN_NOTE, NO_MONEY_TOOLS]) {
      expect(doc).toContain(part);
    }
    for (const t of TOOLS) expect(doc).toContain(`- \`${t.name}\`: ${t.text}`);
  });

  it('configs are valid JSON; PayPal keeps only its read-only tools', () => {
    const before = JSON.parse(CONFIG_BEFORE);
    const after = JSON.parse(CONFIG_AFTER);
    expect(before.mcpServers.paypal.args).toContain('--tools=all');
    expect(after.mcpServers.paypal.args).toContain('--tools=orders.get,transactions.list');
    expect(after.mcpServers.twokey.env).toHaveProperty('TWOKEY_AGENT_TOKEN');
  });

  it('installs twokey-mcp from the pinned GitHub release, never an npm name', () => {
    const after = JSON.parse(CONFIG_AFTER);
    expect(after.mcpServers.twokey.args).toEqual(['-y', MCP_RELEASE_URL]);
    expect(MCP_RELEASE_URL).toMatch(
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/v\d+\.\d+\.\d+\/twokey-mcp-\d+\.\d+\.\d+\.tgz$/,
    );
    expect(MCP_RELEASE_URL).toBe(release.url);
    expect(doc).toContain(release.sha256);
    expect(doc).not.toMatch(/"twokey-mcp"|npx -y twokey-mcp/);
  });

  it('lists exactly the agent tool surface', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      'get_active_rules',
      'get_purchase_status',
      'propose_purchase',
      'search_products',
    ]);
  });
});
