import { defineConfig } from '@playwright/test';

// Two servers: the privacy test runs against the production build (vite
// preview, CSP injected); the spike runs against the dev server so fixture
// iteration doesn't require rebuilds. Both serve /fixtures from bench/fixtures.
const PREVIEW_PORT = 4173;
const DEV_PORT = 5173;

// Managed environments pre-install a Chromium that may not match the pinned
// @playwright/test revision; CHROMIUM_PATH overrides discovery.
const executablePath = process.env.CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  retries: 0,
  // The spike is a measurement, not a check — serialise for stable numbers.
  workers: 1,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    launchOptions: {
      executablePath,
      // Headless GL runs on SwiftShader; fine for functional runs, not for
      // performance verdicts (DECISIONS.md D3).
      args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
    },
  },
  projects: [
    {
      name: 'privacy',
      testMatch: /no-network\.spec\.ts/,
      use: { baseURL: `http://localhost:${PREVIEW_PORT}` },
    },
    {
      name: 'spike',
      testMatch: /spike\.spec\.ts/,
      use: { baseURL: `http://localhost:${DEV_PORT}` },
    },
  ],
  webServer: [
    {
      command: `npm run preview -w web -- --port ${PREVIEW_PORT} --strictPort`,
      port: PREVIEW_PORT,
      cwd: '..',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `npm run dev -w web -- --port ${DEV_PORT} --strictPort`,
      port: DEV_PORT,
      cwd: '..',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
