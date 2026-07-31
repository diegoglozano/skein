// M3 layout determinism (§6, DECISIONS.md D2): same file + seed + machine +
// browser ⇒ same picture. Two fresh browser contexts (fresh OPFS each) must
// compute bit-identical positions; a reload must serve the persisted layout
// with the same hash; a different seed must change the picture.

import { test, expect } from '@playwright/test';
import { ingestAndLayout } from './helpers';

test('same seed is deterministic across fresh contexts; reload hits OPFS', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  page.on('pageerror', (err) => console.error('[page error]', err.message));

  const hashA = await ingestAndLayout(page, 'tiny.csv');
  await expect(page.getByTestId('layout-status')).toContainText('ready');

  // Reload: same picture, served from OPFS this time.
  await page.reload();
  await page.getByLabel('recent graphs').getByRole('button', { name: 'open' }).first().click();
  await expect(page.getByTestId('layout-status')).toContainText('loaded from storage', {
    timeout: 60_000,
  });
  const hashReload = await page.evaluate(
    () => (window as any).__skeinRender.positionsHash as string,
  );
  expect(hashReload).toBe(hashA);

  // Fresh context (fresh OPFS): recompute from scratch, must match exactly.
  const context = await browser.newContext({ baseURL });
  const pageB = await context.newPage();
  pageB.on('pageerror', (err) => console.error('[page error B]', err.message));
  const hashB = await ingestAndLayout(pageB, 'tiny.csv');
  await expect(pageB.getByTestId('layout-status')).toContainText('ready');
  expect(hashB).toBe(hashA);

  // A different seed must produce a different picture.
  await pageB.getByLabel('layout seed').fill('7');
  await pageB.getByRole('button', { name: 're-layout' }).click();
  await expect(pageB.getByTestId('layout-status')).toContainText(/ready/, {
    timeout: 120_000,
  });
  const hashSeed7 = await pageB.evaluate(
    () => (window as any).__skeinRender.positionsHash as string,
  );
  expect(hashSeed7).not.toBe(hashB);
  await context.close();
});
