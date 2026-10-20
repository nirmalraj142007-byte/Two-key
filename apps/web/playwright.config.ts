import { defineConfig, devices } from '@playwright/test';

// Runs against an already running local stack (npm run dev, local Postgres, npm run
// db:seed-users). PLAYWRIGHT_CHANNEL=msedge uses an installed Edge instead of a downloaded
// Chromium.
const channel = process.env.PLAYWRIGHT_CHANNEL;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.WEB_BASE_URL ?? 'http://localhost:3000',
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) },
    },
  ],
});
