// M1 ingest pipeline, end to end against the production build: drop a CSV,
// stream it through the WASM parser in the worker, persist to OPFS, reload
// the page and confirm the graph survived. Fixture counts are exact because
// the generator is deterministic (tiny = 10k nodes / 50k edges).

import { test, expect } from '@playwright/test';
import { dropFixture, ingestAndLayout } from './helpers';

test('ingests tiny.csv: parse, counts, OPFS persistence, reload', async ({ page }) => {
  test.setTimeout(120_000);
  page.on('pageerror', (err) => console.error('[page error]', err.message));

  await page.goto('/');
  await dropFixture(page, 'tiny.csv');

  const summary = page.getByTestId('ingest-summary');
  await expect(summary).toBeVisible({ timeout: 60_000 });
  await expect(summary).toContainText('10,000 nodes');
  await expect(summary).toContainText('50,000 edges');
  await expect(summary).not.toContainText('skipped');

  // Recent list reflects the persisted graph.
  const recent = page.getByLabel('recent graphs');
  await expect(recent).toContainText('tiny.csv');

  // Storage check reads csr.bin/dict.bin back and validates headers + sizes.
  await recent.getByRole('button', { name: 'check storage' }).first().click();
  await expect(recent).toContainText('✓');
  await expect(recent).toContainText('10,000 nodes / 50,000 edges intact on disk');

  // Survives a reload: no re-ingest, straight from OPFS.
  await page.reload();
  await expect(recent).toContainText('tiny.csv', { timeout: 15_000 });
  await recent.getByRole('button', { name: 'check storage' }).first().click();
  await expect(recent).toContainText('intact on disk');
});

test('renders a loaded graph with pan and zoom (M2)', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/');
  await dropFixture(page, 'tiny.csv');
  await expect(page.getByTestId('ingest-summary')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'open graph' }).click();
  await expect(page.getByTestId('graph-view')).toBeVisible();
  await expect(page.getByTestId('render-backend')).toContainText(/webgpu|webgl2/, {
    timeout: 15_000,
  });
  // Layout (M3) must settle — computed on first open, from OPFS afterwards.
  await expect(page.getByTestId('layout-status')).toContainText(/ready|loaded/, {
    timeout: 120_000,
  });

  // Frames are actually being produced.
  await page.waitForFunction(() => ((window as any).__skeinRender?.frames ?? 0) > 10, null, {
    timeout: 15_000,
  });

  // Pan and zoom; the loop must keep rendering without errors.
  const canvas = page.locator('canvas[aria-label="graph canvas"]');
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 80, { steps: 5 });
  await page.mouse.up();
  await page.mouse.wheel(0, -400);
  await page.mouse.wheel(0, 300);
  const before = await page.evaluate(() => (window as any).__skeinRender.frames as number);
  await page.waitForFunction(
    (b) => ((window as any).__skeinRender?.frames ?? 0) > b + 5,
    before,
    { timeout: 15_000 },
  );

  expect(pageErrors, pageErrors.join('\n')).toHaveLength(0);

  // Close returns to the shell.
  await page.getByRole('button', { name: 'close' }).click();
  await expect(page.getByRole('heading', { name: 'skein' })).toBeVisible();
});
