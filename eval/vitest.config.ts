import { defineConfig } from 'vitest/config';

// eval/vendor and eval/data hold third-party clones and data; only our tests run.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
