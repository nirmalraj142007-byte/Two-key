import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createLogger, loadEnv } from '@twokey/core';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

let env: ReturnType<typeof loadEnv<'agent-runner'>>;
try {
  env = loadEnv('agent-runner');
} catch (err) {
  process.stderr.write(`agent-runner: ${err instanceof Error ? err.message : 'invalid config'}\n`);
  process.exit(1);
}

const log = createLogger('agent-runner', env.LOG_LEVEL);

// The worker arrives in phase 12.
createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (req.method === 'GET' && path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'agent-runner',
        version,
        commit: process.env.RENDER_GIT_COMMIT ?? 'dev',
      }),
    );
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
}).listen(env.PORT, '0.0.0.0', () => log.info('agent-runner ready'));
