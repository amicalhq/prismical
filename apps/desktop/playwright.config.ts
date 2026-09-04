import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.artifacts',
  // Startup covers a full Electron boot; keep generous headroom.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // One Electron instance at a time — each launch is a full app boot.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list']],
  use: {
    // Retain failure artifacts for diagnosis.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
