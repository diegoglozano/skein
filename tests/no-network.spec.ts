// The privacy invariant (REQUIREMENTS.md §7): zero requests beyond the initial
// document and same-origin assets. Runs against the production build. This
// gates merges to main.

import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropFixture, generateSample } from './helpers';

const NODE_ATTRS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../bench/fixtures/tiny-nodes.csv',
);

test('app makes no off-origin requests', async ({ page, baseURL }) => {
  // Longer than the 120 s default because this one test drives the whole app —
  // ingest, layout, render, explore, k hops, export and the DuckDB attributes
  // path — and every path added to the app is added here. It sat just under
  // the default and went over it on a loaded runner; the budget is the gate's
  // coverage, so raise the budget.
  test.setTimeout(240_000);
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

  // Sample generation is the one feature that would be trivially tempting to
  // implement as a download ("fetch a demo dataset"), so it is exercised here:
  // the graph must be synthesized in the tab.
  await generateSample(page, 10_000, 50_000);
  await expect(page.getByTestId('ingest-summary')).toContainText('10,000 nodes', {
    timeout: 60_000,
  });

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

  // And through the M4 explore path: id search, selection, and the worker
  // neighbourhood query.
  await page.getByTestId('node-search').fill('n9999');
  await page.getByTestId('search-hit').first().click();
  await expect(page.getByTestId('selection-card')).toContainText('within 1 hop', {
    timeout: 15_000,
  });
  await page.getByTestId('hop-3').click();
  await expect(page.getByTestId('selection-card')).toContainText('within 3 hops', {
    timeout: 30_000,
  });
  // Deliberately not `isolate` as well: it is main-thread style composition
  // over a mask this test has already fetched, so it opens no request surface
  // the colour-by and filter steps below do not already drive — and it would
  // cost this test a styled repaint, which under SwiftShader is three times an
  // unstyled one (D19).
  await page.getByTestId('selection-card').getByRole('button', { name: 'clear selection' }).click();

  // And through the export path (§10), which is the one place the app hands
  // data *out*: a download that went anywhere but a blob URL — even to a
  // formatting service — would be the graph leaving the tab.
  for (const control of ['export-png', 'export-positions']) {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId(control).click(),
    ]);
    expect(await download.path()).toBeTruthy();
  }

  // And through the M4 attributes path. This is the reason the test exists at
  // all for DuckDB: `getJsDelivrBundles()` is what every duckdb-wasm example
  // calls, it resolves the worker and the 34 MB wasm from a CDN, and an app
  // that did that would look and feel identical to this one (D14).
  await page.getByTestId('enable-attributes').click();
  await expect(page.getByTestId('colour-by')).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('attributes-file').setInputFiles(NODE_ATTRS);
  await expect(page.getByTestId('join-report')).toContainText('10,000 of 10,000 nodes matched', {
    timeout: 60_000,
  });
  await page.getByTestId('colour-by').selectOption('kind');
  await page.getByTestId('filter-community').click();
  await page.getByRole('checkbox', { name: 'c0', exact: true }).check();
  await expect(page.getByTestId('filter-count')).toContainText('833', { timeout: 30_000 });

  // Let any deferred requests (lazy chunks, prefetch, telemetry-by-accident)
  // surface before judging.
  await page.waitForTimeout(2000);

  expect(offOrigin, `off-origin requests detected:\n${offOrigin.join('\n')}`).toHaveLength(0);
  expect(all.length, 'expected at least the document + assets').toBeGreaterThan(0);
  // The DuckDB payload is lazy (D14): it must be absent until the panel is
  // opened and present afterwards, or "no CDN" is being proved about a bundle
  // nobody loaded.
  expect(
    all.filter((url) => /duckdb.*\.wasm$/.test(url)),
    'the self-hosted DuckDB wasm was never fetched — the rest of this test proved nothing',
  ).toHaveLength(1);
});

// The no-WebGPU tier runs the whole layout in WASM inside the worker (D11) —
// a distinct code path, so the guarantee is checked there too.
test('no off-origin requests on the WebGL2 fallback layout path', async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const offOrigin: string[] = [];
  page.on('request', (req) => {
    if (new URL(req.url()).origin !== origin) offOrigin.push(req.url());
  });
  page.on('websocket', (ws) => {
    if (new URL(ws.url()).origin !== origin) offOrigin.push(`ws:${ws.url()}`);
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
  });

  await page.goto('/');
  await dropFixture(page, 'tiny.csv');
  await expect(page.getByTestId('ingest-summary')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'open graph' }).click();
  await expect(page.getByTestId('render-backend')).toContainText('webgl2', { timeout: 15_000 });
  await expect(page.getByTestId('layout-status')).toContainText(/ready|loaded/, {
    timeout: 120_000,
  });
  await page.waitForTimeout(2000);

  expect(offOrigin, `off-origin requests detected:\n${offOrigin.join('\n')}`).toHaveLength(0);
});

test('production build carries the same-origin CSP', async ({ page }) => {
  await page.goto('/');
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("default-src 'self'");
});
