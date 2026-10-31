import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// e2e/ holds Playwright specs (npm run e2e:login); Vitest must not collect them.
export default defineConfig({
  resolve: {
    // The app's own '@/…' imports (tsconfig paths), so route handlers can be tested directly.
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    passWithNoTests: true,
  },
});
