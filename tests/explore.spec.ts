// M4 explore surface (§10): search by node id, select, the k-hop
// neighbourhood, isolating it, and hover. The hover assertion doubles as an
// end-to-end check of the pick path — selecting a node centres the camera on
// it, so the node under the canvas centre must be the one we just selected.
// That exercises the camera inverse and the uniform pick grid against real
// laid-out coordinates.
//
// Four of the five tests want the same thing to exist — a laid-out `tiny` —
// and none of them destroys it, so they share one tab created in `beforeAll`
// rather than paying a fresh ingest + layout each. (The isolate test styles
// the graph, which is destructive-looking, but it clears the selection on the
// way out and the release is the last thing it asserts.) The WebGL2 one keeps
// its own tab, because the backend is chosen before any script runs.

import { test, expect, type Page } from '@playwright/test';
import { canvasPixels, ingestAndLayout } from './helpers';

// Wait for drawn frames, so a screenshot sees the current state. Two, not the
// five this used to wait: every caller first waits on the DOM for the state it
// just asked for (a legend, a filter count), so the style is already applied
// and one full frame would do — the second is margin. It matters because a
// *styled* frame is ~3.4x an unstyled one under SwiftShader (the WebGL2 styled
// edge pass draws instanced endpoint pairs, per D14), so five of them measured
// 6.4 s against 3.2 s for two.
async function settle(page: Page): Promise<void> {
  const from = await page.evaluate(() => (window as any).__skeinRender.frames as number);
  await page.waitForFunction((n) => ((window as any).__skeinRender?.frames ?? 0) > n + 2, from, {
    timeout: 30_000,
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
    await expect(card).toContainText('within 1 hop', { timeout: 15_000 });

    // Ground truth straight from the fixture — the CSV has exactly these five
    // rows touching n9999, in either column:
    //   awk -F, '$1=="n9999"||$2=="n9999"' bench/fixtures/tiny.csv
    // Asserting the set (not just self-consistency) is what catches a bad
    // dictionary decode or a one-directional neighbour query.
    await expect(card).toContainText('degree 5');
    await expect(card).toContainText('5 within 1 hop');
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

  // §10's "expand k hops, isolate subgraph". Ground truth again straight from
  // the fixture, computed by a BFS over `tiny.csv` treating it as undirected —
  // 71 nodes lie within two hops of n9999, and the depth control has to agree
  // with that exactly. A count that merely grows would pass against a walk
  // that double-counts or one that forgets to ignore edge direction on the
  // second level.
  test('expanding hops widens the neighbourhood, and isolate hides the rest', async () => {
    await page.getByTestId('node-search').fill('n9999');
    await page.getByTestId('search-hit').first().click();
    const card = page.getByTestId('selection-card');
    await expect(card).toContainText('5 within 1 hop', { timeout: 15_000 });

    await page.getByTestId('hop-2').click();
    await expect(card).toContainText('71 within 2 hops', { timeout: 15_000 });
    // The list caps at 100, and 71 is under it, so every member is on screen.
    await expect(page.getByTestId('neighbor-list').getByRole('button')).toHaveCount(71);
    await expect(page.getByTestId('hop-2')).toHaveAttribute('aria-pressed', 'true');

    // Going back down must shrink it again — the walk restarts from the seed
    // rather than continuing from where the last one stopped.
    await page.getByTestId('hop-1').click();
    await expect(card).toContainText('5 within 1 hop', { timeout: 15_000 });

    // Isolate has to reach the framebuffer: it composes a style buffer out of
    // the worker's mask, and a mask that never got applied would leave the
    // panel saying the right thing over an unchanged picture. Nothing moves
    // the camera between these captures — selecting centres it, and neither
    // the depth buttons nor the checkbox do — so visibility is the only thing
    // that can differ.
    //
    // Only inequality is asserted, here and below. Two captures of the same
    // state are *usually* byte-identical (D19) but not reliably so under
    // SwiftShader, so "the picture came back exactly" is not a claim this
    // suite can make; which nodes the mask covers is pinned natively instead,
    // in skein-core's `khop` tests.
    await settle(page);
    const whole = await canvasPixels(page);
    await page.getByTestId('isolate-toggle').check();
    await settle(page);
    const isolated = await canvasPixels(page);
    expect(whole.equals(isolated), 'isolate did not change the rendered frame').toBe(false);

    // Clearing the selection has to release it: an isolated view with nothing
    // selected is a graph the user cannot get back, and no control would be
    // left on screen to say why. Re-selecting proves the release was of the
    // *mask* and not merely of the checkbox — a checkbox that came back
    // unticked over a still-hidden graph is the failure this catches.
    await card.getByRole('button', { name: 'clear selection' }).click();
    await expect(page.getByTestId('selection-card')).toHaveCount(0);
    await settle(page);
    expect(
      isolated.equals(await canvasPixels(page)),
      'clearing the selection left the graph isolated',
    ).toBe(false);

    await page.getByTestId('search-hit').first().click();
    await expect(card).toContainText('5 within 1 hop', { timeout: 15_000 });
    await expect(page.getByTestId('isolate-toggle')).not.toBeChecked();
    await card.getByRole('button', { name: 'clear selection' }).click();
  });

  // §10 box select. The ground truth here is the app's own hit-testing rather
  // than the fixture — a rectangle over laid-out coordinates has no answer the
  // CSV can give — so the assertions are the ones that hold whatever the
  // layout did: a box over the whole canvas takes every node, a small one
  // takes fewer than that but more than none, and the count on the card is
  // the count the overlay was built from.
  test('dragging a box selects everything inside it', async () => {
    const box = (await page.locator('canvas').boundingBox())!;
    // The tests above leave the camera centred on whatever they selected, so
    // frame the graph before claiming a full-canvas drag covers all of it.
    await page.getByLabel('fit graph to view').click();
    await page.getByTestId('box-select-toggle').click();
    await expect(page.getByTestId('box-select-toggle')).toHaveAttribute('aria-pressed', 'true');

    // Corner to corner. `finishWith` fits the layout with a 15% margin, so
    // every node is inside the canvas by a comfortable distance.
    await page.mouse.move(box.x + 4, box.y + 4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 8 });
    await page.mouse.up();

    const card = page.getByTestId('box-card');
    await expect(card.getByRole('heading')).toHaveText('10,000 nodes selected');
    // The list caps at 100 and says so rather than implying it showed all.
    await expect(page.getByTestId('box-list').getByRole('button')).toHaveCount(100);
    await expect(card).toContainText('listing 100 of 10,000');

    // A quarter of the canvas has to be a strict subset — and non-empty, which
    // is what fails if the screen→world inverse is wrong in a way a full-canvas
    // drag cannot see (it clamps to the grid at both ends).
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 8 });
    await page.mouse.up();
    const inner = Number(
      (await card.getByRole('heading').textContent())!.replace(/[^0-9]/g, ''),
    );
    expect(inner).toBeGreaterThan(0);
    expect(inner).toBeLessThan(10_000);

    // Isolating a box uses the same mask path as a neighbourhood.
    await settle(page);
    const whole = await canvasPixels(page);
    await page.getByTestId('box-isolate-toggle').check();
    await settle(page);
    expect(
      whole.equals(await canvasPixels(page)),
      'isolating a box selection did not change the rendered frame',
    ).toBe(false);

    // Following a member drops back to single selection, which also releases
    // the box's isolation — one highlight, so one selection.
    await page.getByTestId('box-list').getByRole('button').first().click();
    await expect(page.getByTestId('box-card')).toHaveCount(0);
    await expect(page.getByTestId('selection-card')).toBeVisible();
    await expect(page.getByTestId('isolate-toggle')).not.toBeChecked();

    await page.getByTestId('box-select-toggle').click();
    await page
      .getByTestId('selection-card')
      .getByRole('button', { name: 'clear selection' })
      .click();
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
  await expect(page.getByTestId('selection-card')).toContainText('within 1 hop', {
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
