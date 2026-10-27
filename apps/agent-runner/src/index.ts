import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import {
  createLogger,
  installCrashHandlers,
  LISTEN_HOST,
  listeningOn,
  loadEnv,
  reportStartupFailure,
} from '@twokey/core';
import { assertPriced, parseModelList } from './pricing.js';
import { startWorker } from './worker.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

installCrashHandlers('agent-runner');

async function main(): Promise<void> {
  const env = loadEnv('agent-runner');
  const log = createLogger('agent-runner', env.LOG_LEVEL);
  assertPriced([env.AGENT_MODEL, ...parseModelList(env.EVAL_MODELS)]);

  const server = createServer((req, res) => {
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
  });
  server.on('error', (err) => reportStartupFailure('agent-runner', err));
  server.listen(env.PORT, LISTEN_HOST, () => {
    log.info(listeningOn(server.address()), 'listening');
    log.info('agent-runner ready');
  });

  const stopWorker = await startWorker(env, log);
  const shutdown = (): void => {
    server.close();
    void stopWorker().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => reportStartupFailure('agent-runner', err));
