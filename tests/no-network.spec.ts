// The privacy invariant (REQUIREMENTS.md §7): zero requests beyond the initial
// document and same-origin assets. Runs against the production build. This
// gates merges to main.
//
// TODO(M1): extend to load a fixture through the real ingest pipeline once it
// exists — the guarantee must hold under load, not just at rest.

import { test, expect } from '@playwright/test';

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
