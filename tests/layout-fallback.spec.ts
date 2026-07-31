// The no-WebGPU layout tier (§8 graceful degradation, DECISIONS.md D11):
// with `navigator.gpu` removed the renderer falls back to WebGL2 and the whole
// multilevel layout runs in WASM inside the ingest worker. It must still
// finish, still preview, and still be deterministic — the same D2 guarantee as
// the WebGPU path, on the engine that replaced the deleted TS reference sim.
//
// `clustered` (20k/120k) is used deliberately: unlike `tiny` it is above the
// coarsening target, so the hierarchy has two levels and prolongation between
// them is exercised — not just one flat sim.

import { test, expect, type Page } from '@playwright/test';
import { ingestAndLayout } from './helpers';

/** Hide WebGPU from the page before any script runs. */
async function forceWebGl2(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
  });
}

test('WebGL2 fallback lays out in WASM, deterministically', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  page.on('pageerror', (err) => console.error('[page error]', err.message));

  await forceWebGl2(page);
  const hashA = await ingestAndLayout(page, 'clustered.csv');
  await expect(page.getByTestId('render-backend')).toContainText('webgl2');
  await expect(page.getByTestId('layout-status')).toContainText('ready');

  // Fresh context (fresh OPFS): the WASM layout must recompute identically.
  const context = await browser.newContext({ baseURL });
  const pageB = await context.newPage();
  pageB.on('pageerror', (err) => console.error('[page error B]', err.message));
  await forceWebGl2(pageB);
  const hashB = await ingestAndLayout(pageB, 'clustered.csv');
  await expect(pageB.getByTestId('render-backend')).toContainText('webgl2');
  expect(hashB).toBe(hashA);

  // A different seed must produce a different picture (the seed reaches WASM).
  await pageB.getByLabel('layout seed').fill('7');
  await pageB.getByRole('button', { name: 're-layout' }).click();
  await expect(pageB.getByTestId('layout-status')).toContainText(/ready/, {
    timeout: 240_000,
  });
  const hashSeed7 = await pageB.evaluate(
    () => (window as any).__skeinRender.positionsHash as string,
  );
  expect(hashSeed7).not.toBe(hashB);
  await context.close();
});
