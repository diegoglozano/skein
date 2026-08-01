import { defineConfig } from '@playwright/test';

// Two servers by default: the privacy test runs against the production build
// (vite preview, CSP injected), and it runs a second time against the `skein`
// binary, which is a separate deployment path with its own header handling and
// must hold the §7 guarantee on its own (D10). The M0 spike adds a third (the
// dev server, so fixture iteration doesn't require rebuilds) when it is asked
// for. All of them serve /fixtures from bench/fixtures.
const PREVIEW_PORT = 4173;
const DEV_PORT = 5173;
const CLI_PORT = 4273;

// The cosmos.gl spike is a measurement, not a check, and D7 already decided on
// its evidence — nothing in the app imports cosmos.gl any more. Under CI's
// SwiftShader its numbers are not usable for anything (D3/D5), so it cost ~53 s
// of every run to produce a file nobody may cite. It is opt-in now:
// `npm run spike -w tests`, on real hardware, when the question comes back.
const spike = !!process.env.SKEIN_SPIKE;

// Managed environments pre-install a Chromium that may not match the pinned
// @playwright/test revision; CHROMIUM_PATH overrides discovery.
const executablePath = process.env.CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  retries: 0,
  // Every test drives its own page from `goto('/')` and OPFS is per-context, so
  // there is no shared state to order around. The spike is the one exception:
  // it is timing itself, so give it the machine to itself.
  fullyParallel: !spike,
  // SwiftShader rendering is CPU-bound and the runners have 4 cores; two
  // workers is the point where the app project stops queueing without the
  // renderer starving itself.
  workers: spike ? 1 : process.env.CI ? 2 : undefined,
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
      testMatch: /(ingest|layout|layout-fallback|explore|lod|attributes)\.spec\.ts/,
      use: { baseURL: `http://localhost:${PREVIEW_PORT}` },
    },
    ...(spike
      ? [
          {
            name: 'spike',
            testMatch: /spike\.spec\.ts/,
            use: { baseURL: `http://localhost:${DEV_PORT}` },
          },
        ]
      : []),
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
    ...(spike
      ? [
          {
            command: `npm run dev -w web -- --port ${DEV_PORT} --strictPort`,
            port: DEV_PORT,
            cwd: '..',
            reuseExistingServer: !process.env.CI,
            timeout: 30_000,
          },
        ]
      : []),
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
