import { createRequire } from 'node:module';
import { installCrashHandlers, loadEnv, reportStartupFailure } from '@twokey/core';
import { createHttpServer } from './http.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

installCrashHandlers('mcp');

function main(): void {
  const env = loadEnv('mcp');
  const server = createHttpServer({
    gatewayUrl: env.GATEWAY_URL,
    health: { ok: true, service: 'mcp', version, commit: process.env.RENDER_GIT_COMMIT ?? 'dev' },
  });
  server.on('error', (err) => reportStartupFailure('mcp', err));
  server.listen(env.PORT, '0.0.0.0');
}

try {
  main();
} catch (err) {
  reportStartupFailure('mcp', err);
}
