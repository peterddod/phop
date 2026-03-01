import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Cap parallelism: many concurrent WebRTC connections overload the signalling server.
  workers: process.env.CI ? 2 : 2,
  reporter: process.env.CI ? 'github' : 'list',

  use: {
    browserName: 'chromium',
    headless: true,
    actionTimeout: 20_000,
  },

  webServer: [
    {
      command: 'node ../../packages/signalling-server/dist/index.js',
      url: 'http://localhost:8080/health',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'bunx vite --config harness/vite.config.ts --port 9000',
      url: 'http://localhost:9000',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
