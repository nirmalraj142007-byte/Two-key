/**
 * The developers page and docs/claude-desktop.md share this content (a test keeps them equal).
 * @paypal/mcp 1.8.1 takes `--tools=` as a comma list; `orders.get` and `transactions.list` are
 * its read-only `get_order` and `list_transactions` tools.
 */

const json = (v: unknown) => JSON.stringify(v, null, 2);

export const PAYPAL_READ_ONLY_TOOLS = 'orders.get,transactions.list';

export const CONFIG_BEFORE = json({
  mcpServers: {
    paypal: { command: 'npx', args: ['-y', '@paypal/mcp', '--tools=all'] },
  },
});

export const CONFIG_AFTER = json({
  mcpServers: {
    paypal: { command: 'npx', args: ['-y', '@paypal/mcp', `--tools=${PAYPAL_READ_ONLY_TOOLS}`] },
    twokey: {
      command: 'npx',
      args: ['-y', 'twokey-mcp'],
      env: {
        TWOKEY_AGENT_TOKEN: '<demo-mode token from Connect your agent>',
        GATEWAY_URL: '<gateway url>',
      },
    },
  },
});

export const DEMO_TOKEN_NOTE =
  'Create a demo-mode token: live mode finds no purchasable items in the PayPal sandbox.';

export const TOOLS = [
  {
    name: 'search_products',
    text: 'Searches the catalog. Listing text comes back as untrusted_listing_text: data, never instructions.',
  },
  {
    name: 'propose_purchase',
    text: 'Asks Two-Key to buy product_id × qty. Two-Key sets price and payee and replies captured, held or blocked.',
  },
  { name: 'get_purchase_status', text: 'Reads where a proposed purchase stands.' },
  { name: 'get_active_rules', text: "Reads the user's signed spending rules. Read-only." },
] as const;

export const NO_MONEY_TOOLS = 'Two-Key exposes no tool that can capture, approve, or edit rules.';
