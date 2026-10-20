import { defineConfig } from 'vitest/config';

// e2e/ holds Playwright specs (npm run e2e:login); Vitest must not collect them.
export default defineConfig({
  test: {
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    passWithNoTests: true,
  },
});
