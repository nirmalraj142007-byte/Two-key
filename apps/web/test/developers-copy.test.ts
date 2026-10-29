import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_AFTER,
  CONFIG_BEFORE,
  DEMO_TOKEN_NOTE,
  NO_MONEY_TOOLS,
  TOOLS,
} from '../lib/developers-copy';

const doc = readFileSync(new URL('../../../docs/claude-desktop.md', import.meta.url), 'utf8');

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

  it('lists exactly the agent tool surface', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      'get_active_rules',
      'get_purchase_status',
      'propose_purchase',
      'search_products',
    ]);
  });
});
