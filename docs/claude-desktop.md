# Two-Key with Claude Desktop

For developers shipping agents on PayPal's MCP server. Keep PayPal's read-only tools, drop the ones that move money, and add Two-Key.

## Claude Desktop

In `claude_desktop_config.json`, limit PayPal to reading orders and transactions (`orders.get` and `transactions.list`, which `@paypal/mcp` exposes as `get_order` and `list_transactions`), and add the `twokey` server. Keep your existing PayPal `env` block.

`twokey-mcp` is not on npm. `npx` installs it from the v1.0.0 GitHub release asset (sha256 `1aa831a27f16d1c62c31acb281029dac7e0accd73f1c8fe093f3d953ef5f1036`, pinned in `apps/mcp/release.json`).

Create a demo-mode token: live mode finds no purchasable items in the PayPal sandbox. Get it from Connect your agent (`/onboarding/agent`).

Before:

```json
{
  "mcpServers": {
    "paypal": {
      "command": "npx",
      "args": [
        "-y",
        "@paypal/mcp",
        "--tools=all"
      ]
    }
  }
}
```

After:

```json
{
  "mcpServers": {
    "paypal": {
      "command": "npx",
      "args": [
        "-y",
        "@paypal/mcp",
        "--tools=orders.get,transactions.list"
      ]
    },
    "twokey": {
      "command": "npx",
      "args": [
        "-y",
        "https://github.com/nirmalraj142007-byte/Two-key/releases/download/v1.0.0/twokey-mcp-1.0.0.tgz"
      ],
      "env": {
        "TWOKEY_AGENT_TOKEN": "<demo-mode token from Connect your agent>",
        "GATEWAY_URL": "<gateway url>"
      }
    }
  }
}
```

## Any MCP client over Streamable HTTP

Point the client at the Two-Key MCP URL and send the agent token as a bearer token.

```text
URL:    <MCP URL from Connect your agent>
Header: Authorization: Bearer <demo-mode token from Connect your agent>
```

## The four tools

- `search_products`: Searches the catalog. Listing text comes back as untrusted_listing_text: data, never instructions.
- `propose_purchase`: Asks Two-Key to buy product_id × qty. Two-Key sets price and payee and replies captured, held or blocked.
- `get_purchase_status`: Reads where a proposed purchase stands.
- `get_active_rules`: Reads the user's signed spending rules. Read-only.

Two-Key exposes no tool that can capture, approve, or edit rules.
