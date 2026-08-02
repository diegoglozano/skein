// M4 explore surface (§10): search by node id, select, 1-hop neighbourhood,
// and hover. The hover assertion doubles as an end-to-end check of the pick
// path — selecting a node centres the camera on it, so the node under the
// canvas centre must be the one we just selected. That exercises the camera
// inverse and the uniform pick grid against real laid-out coordinates.
//
// Three of the four tests want the same thing to exist — a laid-out `tiny` —
// and none of them destroys it, so they share one tab created in `beforeAll`
// rather than paying a fresh ingest + layout each. The WebGL2 one keeps its
// own, because the backend is chosen before any script runs.

import { test, expect, type Page } from '@playwright/test';
import { canvasPixels, ingestAndLayout } from './helpers';

/** Wait for a few more drawn frames, so a screenshot sees the current state. */
async function settle(page: Page): Promise<void> {
  const from = await page.evaluate(() => (window as any).__skeinRender.frames as number);
  await page.waitForFunction((n) => ((window as any).__skeinRender?.frames ?? 0) > n + 5, from, {
    timeout: 15_000,
  });
}

test.describe('explore on a laid-out graph', () => {
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
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test('search selects a node, lists its neighbours, and hover picks it back', async () => {
    // `tiny` node ids are n0..n9999, so this query has exactly one prefix hit.
    await page.getByTestId('node-search').fill('n9999');
    const hits = page.getByTestId('search-hit');
    await expect(hits).toHaveCount(1);
    await expect(hits.first()).toHaveText('n9999');

    await hits.first().click();
    const card = page.getByTestId('selection-card');
    await expect(card.getByRole('heading')).toHaveText('n9999');
    await expect(card).toContainText('neighbours', { timeout: 15_000 });

    // Ground truth straight from the fixture — the CSV has exactly these five
    // rows touching n9999, in either column:
    //   awk -F, '$1=="n9999"||$2=="n9999"' bench/fixtures/tiny.csv
    // Asserting the set (not just self-consistency) is what catches a bad
    // dictionary decode or a one-directional neighbour query.
    await expect(card).toContainText('degree 5');
    await expect(card).toContainText('5 neighbours');
    const neighbors = page.getByTestId('neighbor-list').getByRole('button');
    await expect(neighbors).toHaveCount(5);
    expect((await neighbors.allTextContents()).sort()).toEqual([
      'n1127',
      'n2014',
      'n2437',
      'n3173',
      'n5647',
    ]);

    // Following a neighbour re-selects it, with its own degree.
    const neighborId = 'n5647';
    await neighbors.filter({ hasText: neighborId }).click();
    await expect(card.getByRole('heading')).toHaveText(neighborId);
    await expect(card).toContainText('degree 8');

    // The overlay must reach the framebuffer, not merely be uploaded. Clearing
    // the selection leaves the camera untouched, so the highlight is the only
    // thing that can differ between these two frames. Whichever backend this
    // run picked gets checked — headless has no WebGPU, so CI covers WebGL2 and
    // a headed run on real hardware covers WebGPU (DECISIONS.md D3).
    await settle(page);
    const highlighted = await canvasPixels(page);

    await card.getByRole('button', { name: 'clear selection' }).click();
    await expect(page.getByTestId('selection-card')).toHaveCount(0);
    await settle(page);
    const plain = await canvasPixels(page);
    expect(highlighted.equals(plain), 'highlight overlay did not change the rendered frame').toBe(
      false,
    );

    // Clearing left the camera centred on that node; hovering the canvas centre
    // must hit-test back to it.
    const box = (await page.locator('canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByTestId('hover-card').getByRole('heading')).toHaveText(neighborId);
  });

  test('a query with no match reports it', async () => {
    await page.getByTestId('node-search').fill('nope-not-a-node');
    await expect(page.getByTestId('search-results')).toContainText('no match');
  });

  // Last in the group: re-layout replaces the positions the tests above assert
  // against, so it runs once nobody else needs the original picture.
  //
  // Re-layout re-runs the render effect with a fresh Camera while the <canvas>
  // element persists, so anything that initialises the camera only when the
  // backing store changes silently leaves it on its 1x1 default — projection and
  // hit-testing both break, and a positions-hash assertion would not notice.
  test('picking still works after a re-layout', async () => {
    await page.getByTestId('node-search').fill('n9999');
    await page.getByTestId('search-hit').first().click();
    await expect(page.getByTestId('selection-card').getByRole('heading')).toHaveText('n9999');

    await page.getByLabel('layout seed').fill('7');
    await page.getByRole('button', { name: 're-layout' }).click();
    await expect(page.getByTestId('layout-status')).toContainText(/ready|loaded/, {
      timeout: 120_000,
    });

    // Same round trip as the first test, on the new layout: select, then confirm
    // the centred node hit-tests back under the cursor.
    await page.getByTestId('node-search').fill('n9999');
    await page.getByTestId('search-hit').first().click();
    await expect(page.getByTestId('selection-card').getByRole('heading')).toHaveText('n9999');
    await page.getByTestId('selection-card').getByRole('button', { name: 'clear selection' }).click();

    const box = (await page.locator('canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByTestId('hover-card').getByRole('heading')).toHaveText('n9999');
  });
});

// The two renderers implement the highlight overlay separately (storage
// buffers vs. instanced attributes), and a GL error on the fallback path fails
// silently — so drive selection there too.
test('the WebGL2 fallback highlights a selection without erroring', async ({ page }) => {
  test.setTimeout(180_000);
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

  await page.getByTestId('node-search').fill('n9999');
  await page.getByTestId('search-hit').first().click();
  await expect(page.getByTestId('selection-card')).toContainText('neighbours', {
    timeout: 15_000,
  });

  // The overlay must actually reach the framebuffer, not just be uploaded —
  // a bad GL draw call raises no exception. Clearing the selection leaves the
  // camera untouched, so the only thing that can change between these two
  // screenshots is the highlight itself.
  await settle(page);
  const highlighted = await canvasPixels(page);

  await page.getByTestId('selection-card').getByRole('button', { name: 'clear selection' }).click();
  await expect(page.getByTestId('selection-card')).toHaveCount(0);
  await settle(page);
  const plain = await canvasPixels(page);

  expect(highlighted.equals(plain), 'highlight overlay did not change the rendered frame').toBe(
    false,
  );
  expect(errors, errors.join('\n')).toHaveLength(0);
});
