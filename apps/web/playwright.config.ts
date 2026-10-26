import { defineConfig, devices } from '@playwright/test';

// The login spec needs the full local stack (npm run dev, local Postgres, npm run
// db:seed-users). The styleguide spec needs only web, which webServer starts if nothing is
// listening on :3000 yet. PLAYWRIGHT_CHANNEL=msedge uses an installed Edge instead of a
// downloaded Chromium.
const channel = process.env.PLAYWRIGHT_CHANNEL;
const baseURL = process.env.WEB_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'off',
  },
  webServer: {
    command: 'npm run dev -w @twokey/web',
    cwd: '../..',
    url: `${baseURL}/styleguide`,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) },
    },
  ],
});
