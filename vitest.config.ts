import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Local runs (npm test, or npx vitest on one file) pick up DATABASE_URL from .env.gateway.
// Variables already set, even to '', win; CI has no such file.
const gatewayEnv = new URL('./.env.gateway', import.meta.url);
if (existsSync(gatewayEnv)) process.loadEnvFile(gatewayEnv);

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'scripts', 'eval*'],
  },
});
