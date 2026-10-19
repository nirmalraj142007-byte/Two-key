import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { installCrashHandlers, loadEnv, reportStartupFailure } from '@twokey/core';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

installCrashHandlers('mcp');

function main(): void {
  const env = loadEnv('mcp');
  // The real MCP server arrives in phase 11.
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          service: 'mcp',
          version,
          commit: process.env.RENDER_GIT_COMMIT ?? 'dev',
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  });
  server.on('error', (err) => reportStartupFailure('mcp', err));
  server.listen(env.PORT, '0.0.0.0');
}

try {
  main();
} catch (err) {
  reportStartupFailure('mcp', err);
}
