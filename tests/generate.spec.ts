// Sample graph generation: the app can make its own data, for a device that
// has none — a phone, or a laptop that has never run `npm run fixtures`. The
// size is the user's, typed into two fields.
//
// The last test is the one that matters. `web/src/workers/generate.ts` is a
// deliberate copy of `bench/generate-fixtures.mjs`, and nothing but this test
// stops the two drifting: an identical graph lays out to an identical position
// hash (§6, D2), so a change to either generator that the other did not get
// turns this red. It asks for the `tiny` fixture's numbers, which is what makes
// the two graphs comparable at all.

import { test, expect } from '@playwright/test';
import { generateAndLayout, generateSample, ingestAndLayout } from './helpers';

test('generates a sample graph of a requested size with no file on the device', async ({
  page,
}) => {
  test.setTimeout(120_000);
  page.on('pageerror', (err) => console.error('[page error]', err.message));

  await page.goto('/');
  await generateSample(page, 10_000, 50_000);

  const summary = page.getByTestId('ingest-summary');
  await expect(summary).toBeVisible({ timeout: 60_000 });
  await expect(summary).toContainText('10,000 nodes');
  await expect(summary).toContainText('50,000 edges');
  await expect(summary).not.toContainText('skipped');

  // It is an ordinary graph from here on: same OPFS layout, same manifest,
  // same storage check, and it survives a reload like any imported file.
  const recent = page.getByLabel('recent graphs');
  await expect(recent).toContainText('10,000×50,000 (generated)');
  await recent.getByRole('button', { name: 'check storage' }).first().click();
  await expect(recent).toContainText('10,000 nodes / 50,000 edges intact on disk');

  await page.reload();
  await expect(recent).toContainText('10,000×50,000 (generated)', { timeout: 15_000 });

  // Regenerating overwrites in place rather than piling up copies — the id is
  // per size, not per import.
  await generateSample(page, 10_000, 50_000);
  await expect(summary).toBeVisible({ timeout: 60_000 });
  await expect(recent.getByRole('listitem')).toHaveCount(1);

  // A different size is a different graph, not a second copy of the first.
  await generateSample(page, 5_000, 20_000);
  await expect(summary).toContainText('5,000 nodes', { timeout: 60_000 });
  await expect(recent.getByRole('listitem')).toHaveCount(2);
});

test('refuses a size it cannot honour instead of generating a smaller graph', async ({ page }) => {
  await page.goto('/');

  // Ids exist only where an edge mentions them, so fewer edges than nodes
  // would quietly come back as a smaller graph than the one asked for.
  await page.getByTestId('generate-nodes').fill('10000');
  await page.getByTestId('generate-edges').fill('500');
  await expect(page.getByTestId('generate-error')).toContainText('at least one edge');
  await expect(page.getByTestId('generate-run')).toBeDisabled();

  await page.getByTestId('generate-edges').fill('50000');
  await expect(page.getByTestId('generate-error')).toHaveCount(0);
  await expect(page.getByTestId('generate-run')).toBeEnabled();

  // And the ceiling, which is what stops a typo allocating gigabytes.
  await page.getByTestId('generate-nodes').fill('50000000');
  await expect(page.getByTestId('generate-error')).toContainText('node count must be between');
  await expect(page.getByTestId('generate-run')).toBeDisabled();
});

test('a generated graph is the same graph as the fixture of that size', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  page.on('pageerror', (err) => console.error('[page error]', err.message));

  const fixtureHash = await ingestAndLayout(page, 'tiny.csv');

  // Fresh context, so the generated graph is laid out against a fresh OPFS
  // with nothing of the fixture run left to fall back on.
  const context = await browser.newContext({ baseURL });
  const generated = await context.newPage();
  generated.on('pageerror', (err) => console.error('[page error B]', err.message));
  const generatedHash = await generateAndLayout(generated, 10_000, 50_000);
  await context.close();

  expect(
    generatedHash,
    'generate.ts and bench/generate-fixtures.mjs have diverged — they must produce the same graph',
  ).toBe(fixtureHash);
});
