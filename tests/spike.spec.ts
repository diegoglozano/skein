// M0 spike runner: drives web/spike.html against a fixture and writes the
// metrics JSON to bench/results/. Select the fixture with SPIKE_FIXTURE
// (default: tiny, which CI can afford under SwiftShader).
//
// The wrap-vs-build verdict (DECISIONS.md D3) must come from a run on real
// hardware: `SPIKE_FIXTURE=medium npm run spike -w tests` on the reference
// laptop. CI runs are functional validation only.

import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = process.env.SPIKE_FIXTURE ?? 'tiny';
// Real-hardware runs want the full 120s convergence budget; CI functional runs
// don't need to sit through it on software GL.
const simCapMs = process.env.SPIKE_SIM_CAP_MS ?? '120000';
const resultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../bench/results');

test('cosmos.gl spike produces metrics', async ({ page }) => {
  test.setTimeout(900_000);

  page.on('pageerror', (err) => console.error('[page error]', err.message));

  await page.goto(`/spike.html?fixture=${fixture}&simCapMs=${simCapMs}`);
  await page.waitForFunction(() => (window as any).__spike?.done, null, {
    timeout: 880_000,
    polling: 1000,
  });

  const metrics = await page.evaluate(() => (window as any).__spike);
  expect(metrics.error, metrics.error).toBeUndefined();
  expect(metrics.nodes).toBeGreaterThan(0);
  expect(metrics.simTicks).toBeGreaterThan(0);

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const out = path.join(resultsDir, `spike-${fixture}-${stamp}.json`);
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(
    out,
    JSON.stringify({ ...metrics, userAgent: await page.evaluate(() => navigator.userAgent) }, null, 2),
  );
  console.log(`spike metrics → ${out}`);
  console.log(JSON.stringify(metrics, null, 2));
});
