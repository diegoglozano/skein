import { defineConfig } from '@playwright/test';

// Three servers: the privacy test runs against the production build (vite
// preview, CSP injected); the spike runs against the dev server so fixture
// iteration doesn't require rebuilds; and the privacy test runs a second time
// against the `skein` binary, which is a separate deployment path with its own
// header handling and must hold the §7 guarantee on its own (D10).
// All three serve /fixtures from bench/fixtures.
const PREVIEW_PORT = 4173;
const DEV_PORT = 5173;
const CLI_PORT = 4273;

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
      name: 'app',
      testMatch: /(ingest|layout)\.spec\.ts/,
      use: { baseURL: `http://localhost:${PREVIEW_PORT}` },
    },
    {
      name: 'spike',
      testMatch: /spike\.spec\.ts/,
      use: { baseURL: `http://localhost:${DEV_PORT}` },
    },
    {
      name: 'cli',
      testMatch: /no-network\.spec\.ts/,
      use: { baseURL: `http://localhost:${CLI_PORT}` },
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
    {
      // Embeds whatever is in web/dist at compile time, so `npm run build`
      // must have run first. The generous timeout covers a cold cargo build.
      command:
        `cargo run --quiet --release -p skein -- serve ` +
        `--port ${CLI_PORT} --no-open --fixtures bench/fixtures`,
      port: CLI_PORT,
      cwd: '..',
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
  ],
});
