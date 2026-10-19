import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { loadEnv } from '@twokey/core';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

let env: ReturnType<typeof loadEnv<'mcp'>>;
try {
  env = loadEnv('mcp');
} catch (err) {
  process.stderr.write(`mcp: ${err instanceof Error ? err.message : 'invalid config'}\n`);
  process.exit(1);
}

// The real MCP server arrives in phase 11.
createServer((req, res) => {
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
}).listen(env.PORT, '0.0.0.0');
