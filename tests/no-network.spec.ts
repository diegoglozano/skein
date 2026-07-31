// The privacy invariant (REQUIREMENTS.md §7): zero requests beyond the initial
// document and same-origin assets. Runs against the production build. This
// gates merges to main.

import { test, expect } from '@playwright/test';
import { dropFixture } from './helpers';

test('app makes no off-origin requests', async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const offOrigin: string[] = [];
  const all: string[] = [];

  page.on('request', (req) => {
    all.push(req.url());
    if (new URL(req.url()).origin !== origin) offOrigin.push(req.url());
  });
  page.on('websocket', (ws) => {
    if (new URL(ws.url()).origin !== origin) offOrigin.push(`ws:${ws.url()}`);
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'skein' })).toBeVisible();

  // Exercise what UI exists; grows with the app.
  await page.getByRole('button', { name: /your data never leaves/i }).click();
  await expect(page.getByText('Verify it yourself')).toBeVisible();

  // The guarantee must hold under load, not just at rest: run the full ingest
  // pipeline (worker + WASM fetch + OPFS writes) on a real file.
  await dropFixture(page, 'tiny.csv');
  await expect(page.getByTestId('ingest-summary')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('ingest-summary')).toContainText('10,000 nodes');

  // And through the render + layout paths (M2/M3): open the graph, run the
  // multilevel layout (hierarchy in WASM, sim, OPFS position save), draw.
  await page.getByRole('button', { name: 'open graph' }).click();
  await expect(page.getByTestId('render-backend')).toContainText(/webgpu|webgl2/, {
    timeout: 15_000,
  });
  await expect(page.getByTestId('layout-status')).toContainText(/ready|loaded/, {
    timeout: 120_000,
  });
  await page.waitForFunction(() => ((window as any).__skeinRender?.frames ?? 0) > 10, null, {
    timeout: 15_000,
  });

  // Let any deferred requests (lazy chunks, prefetch, telemetry-by-accident)
  // surface before judging.
  await page.waitForTimeout(2000);

  expect(offOrigin, `off-origin requests detected:\n${offOrigin.join('\n')}`).toHaveLength(0);
  expect(all.length, 'expected at least the document + assets').toBeGreaterThan(0);
});

test('production build carries the same-origin CSP', async ({ page }) => {
  await page.goto('/');
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("default-src 'self'");
});
