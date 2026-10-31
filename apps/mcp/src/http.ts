import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requestIdFrom } from '@twokey/core';
import { GatewayClient } from './gateway-client.js';
import { createTwoKeyServer } from './server.js';

export interface HttpOptions {
  gatewayUrl: string;
  health: Record<string, unknown>;
}

const MAX_BODY_BYTES = 1_000_000;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

export function createHttpServer(opts: HttpOptions): Server {
  return createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/healthz') {
      json(res, 200, opts.health);
      return;
    }
    if (path !== '/mcp') {
      json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }

    const token = /^Bearer (tk_agent_[A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) {
      json(res, 401, {
        error: { code: 'UNAUTHENTICATED', message: 'Send Authorization: Bearer tk_agent_…' },
      });
      return;
    }
    if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
      json(res, 405, { error: { code: 'VALIDATION', message: 'Method not allowed' } });
      return;
    }

    // Stateless: a new server and transport per request, holding only this request's token.
    const requestId = requestIdFrom(req.headers['x-request-id']);
    res.setHeader('x-request-id', requestId);
    const server = createTwoKeyServer(new GatewayClient(opts.gatewayUrl, token, requestId), {
      token,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) {
        json(res, 400, { error: { code: 'VALIDATION', message: 'Invalid MCP request' } });
      }
    }
  });
}
