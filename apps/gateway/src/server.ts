import { loadEnv } from '@twokey/core';
import { buildApp } from './app.js';

let env: ReturnType<typeof loadEnv<'gateway'>>;
try {
  env = loadEnv('gateway');
} catch (err) {
  process.stderr.write(`gateway: ${err instanceof Error ? err.message : 'invalid config'}\n`);
  process.exit(1);
}

const app = buildApp(env);
app.listen({ port: env.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error({ err }, 'gateway failed to start');
  process.exit(1);
});
