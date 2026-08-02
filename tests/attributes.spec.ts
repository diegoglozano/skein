// M4 attributes (§10, DECISIONS.md D4/D14): the two-file join, colour and size
// by column, and filters.
//
// The counts asserted here are ground truth read off the fixtures, not values
// the app produced — `bench/fixtures/tiny-nodes.csv` carries a row per node
// plus ten `ghost*` ids that appear in no edge, which is what makes the
// unmatched-key report testable:
//
//   graph nodes 10,000 · attribute rows 10,010 · matched 10,000 · unmatched 10
//   community c0 covers 833 of the graph's nodes
//
// Filters are checked at the framebuffer, not just in the sidebar: hiding a
// node has to reach the renderer, and both backends implement that separately.
//
// Setup is shared, deliberately. Ingest + layout + a DuckDB start cost ~30 s
// under SwiftShader and every test below used to pay it: seven tests, seven
// 35 MB wasm instantiations, for one graph nobody mutates destructively. The
// five tests that only need "a laid-out tiny graph with attributes attached"
// now run serially against one page created in `beforeAll`. The two that need
// a *clean* tab — the one proving DuckDB is not fetched, and the WebGL2 one —
// keep their own, because a warm tab would make both vacuous.

import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canvasPixels, ingestAndLayout } from './helpers';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bench/fixtures');
const NODE_ATTRS = path.join(FIXTURES, 'tiny-nodes.csv');

/** Wait for a few more drawn frames, so a screenshot sees the current state. */
async function settle(page: Page): Promise<void> {
  const from = await page.evaluate(() => (window as any).__skeinRender.frames as number);
  await page.waitForFunction((n) => ((window as any).__skeinRender?.frames ?? 0) > n + 5, from, {
    timeout: 15_000,
  });
}

/** Turn the panel on and wait for DuckDB to finish starting. */
async function enableAttributes(page: Page): Promise<void> {
  await page.getByTestId('enable-attributes').click();
  await expect(page.getByTestId('colour-by')).toBeVisible({ timeout: 120_000 });
}

async function attachNodeAttributes(page: Page): Promise<void> {
  await page.getByTestId('attributes-file').setInputFiles(NODE_ATTRS);
  await expect(page.getByTestId('join-report')).toBeVisible({ timeout: 60_000 });
}

// The shared-setup group. Serial because they share a tab: a failure part way
// through leaves the page in a state the rest cannot interpret, so Playwright
// skipping the remainder is the honest outcome rather than a cascade of
// confusing failures.
test.describe('attributes on a laid-out graph', () => {
  // 300 s to match the per-test budget these carried before they shared a page:
  // the first one pays the whole setup, and SwiftShader is slow.
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let page: Page;

  test.beforeAll(async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      baseURL: (testInfo.project.use as { baseURL?: string }).baseURL,
    });
    page = await context.newPage();
    page.on('pageerror', (err) => console.error('[page error]', err.message));
    await ingestAndLayout(page, 'tiny.csv');
    await enableAttributes(page);
    await attachNodeAttributes(page);
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test('attributes join onto nodes and report unmatched keys', async () => {
    const report = page.getByTestId('join-report');
    await expect(report).toContainText('joined on id');
    await expect(report).toContainText('10,000 of 10,000 nodes matched');
    // The ten ghost ids: D4 promised unmatched-key reporting, so it is asserted.
    await expect(report).toContainText('10 rows matched no node');

    // The attached columns are discoverable, with DuckDB's inferred types.
    await expect(page.getByTestId('filter-community')).toBeVisible();
    await expect(page.getByTestId('filter-score')).toBeVisible();
    await expect(page.getByTestId('filter-kind')).toBeVisible();
    // `degree` comes from the graph itself, so it is present either way.
    await expect(page.getByTestId('filter-degree')).toBeVisible();
  });

  test('colour by a column repaints the canvas and shows a legend', async () => {
    await settle(page);
    const plain = await canvasPixels(page);

    await page.getByTestId('colour-by').selectOption('kind');
    // Identity is never colour alone (§10's attribute card plus this legend).
    await expect(page.getByTestId('colour-legend')).toBeVisible();
    await settle(page);
    const coloured = await canvasPixels(page);
    expect(coloured.equals(plain), 'colour-by did not change the rendered frame').toBe(false);

    // A numeric column takes the sequential ramp instead of the categorical
    // swatches — a different code path through the style query.
    await page.getByTestId('colour-by').selectOption('score');
    await settle(page);
    const sequential = await canvasPixels(page);
    expect(sequential.equals(coloured), 'switching to a numeric column changed nothing').toBe(
      false,
    );

    // Sizing is a separate byte of the same packed style word.
    await page.getByTestId('size-by').selectOption('degree');
    await settle(page);
    const sized = await canvasPixels(page);
    expect(sized.equals(sequential), 'size-by did not change the rendered frame').toBe(false);
  });

  test('a filter hides nodes, counts them, and clears back', async () => {
    await settle(page);
    const unfiltered = await canvasPixels(page);

    await page.getByTestId('filter-community').click(); // open the <details>
    await page.getByRole('checkbox', { name: 'c0', exact: true }).check();

    // 833 is counted from the fixture, not from the app.
    await expect(page.getByTestId('filter-count')).toHaveText('showing 833 of 10,000 nodes', {
      timeout: 30_000,
    });

    await settle(page);
    const filtered = await canvasPixels(page);
    expect(filtered.equals(unfiltered), 'the filter did not reach the framebuffer').toBe(false);

    await page.getByTestId('clear-filters').click();
    await expect(page.getByTestId('filter-count')).toHaveCount(0);
  });

  test('the selection card shows the selected node attributes', async () => {
    await page.getByTestId('node-search').fill('n9999');
    await page.getByTestId('search-hit').first().click();

    const card = page.getByTestId('attribute-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    // n9999 is in the last community (min(11, floor(9999/833)) = 11), and the
    // graph's own degree column comes through the same view.
    await expect(card).toContainText('community');
    await expect(card).toContainText('c11');
    await expect(card).toContainText('degree');
  });

  // Last in the group: it closes and reopens the graph, which is the one piece
  // of setup state the others depend on.
  test('an attached file survives closing and reopening the graph', async () => {
    await page.getByRole('button', { name: 'close' }).click();
    // `name: 'open'` alone also matches "open graph" in the ingest summary, which
    // reopens from the snapshot taken before the file was attached.
    await page
      .getByRole('region', { name: 'recent graphs' })
      .getByRole('button', { name: 'open', exact: true })
      .click();
    await expect(page.getByTestId('layout-status')).toContainText(/ready|loaded/, {
      timeout: 120_000,
    });

    // No click on "enable" this time — the panel restores itself.
    await expect(page.getByTestId('join-report')).toContainText('10,000 of 10,000 nodes matched', {
      timeout: 120_000,
    });
  });
});

// The payload is the reason attributes are behind a switch at all (D14): a
// session that never asks for them must not pay 34 MB for the option. Needs a
// tab that has never opened the panel, so it cannot share the group above.
test('the DuckDB payload is not fetched until attributes are asked for', async ({ page }) => {
  test.setTimeout(300_000);
  const requested: string[] = [];
  page.on('request', (req) => requested.push(req.url()));

  await ingestAndLayout(page, 'tiny.csv');
  // Exercise the rest of the app first — ingest, layout, render, explore.
  await page.getByTestId('node-search').fill('n9999');
  await page.getByTestId('search-hit').first().click();
  await expect(page.getByTestId('selection-card')).toContainText('neighbours', {
    timeout: 15_000,
  });
  await page.waitForTimeout(2000);
  expect(
    requested.filter((url) => /duckdb/i.test(url)),
    'DuckDB was fetched by a session that never opened the attributes panel',
  ).toHaveLength(0);

  await enableAttributes(page);
  expect(requested.filter((url) => /duckdb.*\.wasm$/.test(url))).toHaveLength(1);
});

// The two renderers implement per-node style separately — a storage buffer plus
// unpack4x8unorm on WebGPU, an RGBA8 texture plus instanced endpoint pairs on
// WebGL2 — and a bad GL draw fails silently rather than throwing. Needs its own
// tab: the backend is chosen before any script runs.
test('the WebGL2 fallback colours and filters without erroring', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
  });

  await ingestAndLayout(page, 'tiny.csv');
  await expect(page.getByTestId('render-backend')).toContainText('webgl2');
  await enableAttributes(page);
  await attachNodeAttributes(page);

  await settle(page);
  const plain = await canvasPixels(page);

  await page.getByTestId('colour-by').selectOption('kind');
  await settle(page);
  const coloured = await canvasPixels(page);
  expect(coloured.equals(plain), 'colour-by did not change the WebGL2 frame').toBe(false);

  await page.getByTestId('filter-community').click();
  await page.getByRole('checkbox', { name: 'c0', exact: true }).check();
  await expect(page.getByTestId('filter-count')).toHaveText('showing 833 of 10,000 nodes', {
    timeout: 30_000,
  });
  await settle(page);
  const filtered = await canvasPixels(page);
  expect(filtered.equals(coloured), 'the filter did not reach the WebGL2 framebuffer').toBe(false);

  expect(errors, errors.join('\n')).toHaveLength(0);
});
