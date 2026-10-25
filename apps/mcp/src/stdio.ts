#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GatewayClient } from './gateway-client.js';
import { createTwoKeyServer } from './server.js';

const token = process.env.TWOKEY_AGENT_TOKEN;
const gatewayUrl = process.env.GATEWAY_URL;
if (!token || !gatewayUrl) {
  process.stderr.write('Set TWOKEY_AGENT_TOKEN (from Two-Key → Connect your agent)\n');
  process.exit(1);
}

const server = createTwoKeyServer(new GatewayClient(gatewayUrl, token), { token });
await server.connect(new StdioServerTransport());
