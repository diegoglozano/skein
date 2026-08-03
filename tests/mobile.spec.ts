// Phone-shaped viewports: the canvas has to be the app, and touch has to be
// able to drive it. Both were broken at once — a 17rem sidebar plus a
// three-row HUD left a sliver of canvas, and zoom existed only as a wheel
// event, which a touch screen never sends.
//
// Everything here runs at 390×844 with touch enabled; the rest of the suite
// runs at Playwright's default 1280×720, which is the docked-sidebar layout.

import { expect, test, type Page } from '@playwright/test';
import { ingestAndLayout } from './helpers';

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 };

test.use(PHONE);

/** Live camera zoom, published by the render loop. */
const zoomOf = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as { __skeinRender?: { zoom: number } }).__skeinRender!.zoom);

/**
 * A pinch, as the browser's own input pipeline sees it: CDP touch events, which
 * Chromium turns into the multi-pointer stream the view listens to. Playwright's
 * touchscreen API is single-contact, so it cannot express this at all.
 */
async function pinch(
  page: import('@playwright/test').Page,
  centre: { x: number; y: number },
  from: number,
  to: number,
) {
  const client = await page.context().newCDPSession(page);
  const at = (gap: number) => [
    { x: centre.x - gap / 2, y: centre.y, id: 1 },
    { x: centre.x + gap / 2, y: centre.y, id: 2 },
  ];
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from) });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: at(from + ((to - from) * i) / steps),
    });
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await client.detach();
}

// One laid-out `tiny` for all three (D19). Each used to pay its own ingest and
// layout — the cost the zoom test's own comment already noticed when it merged
// the pinch and button paths into one test. Nothing here destroys the graph, so
// the only constraint is order: the zoom test leaves the camera below fit, so
// it goes last, and the tap test re-centres the camera itself via search.
test.describe.configure({ mode: 'serial', timeout: 300_000 });

let page: Page;

test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    ...PHONE,
    baseURL: (testInfo.project.use as { baseURL?: string }).baseURL,
  });
  page = await context.newPage();
  await ingestAndLayout(page, 'tiny.csv');
});

test.afterAll(async () => {
  await page?.context().close();
});

/**
 * Top of the sheet, polled. It slides on a 0.2 s CSS transition, so a single
 * `boundingBox()` taken right after the state that moves it samples the
 * animation rather than its destination — which passes or fails on how long
 * the preceding step happened to take.
 */
async function sheetTop(): Promise<number> {
  return (await page.getByLabel('explore panel').boundingBox())!.y;
}

test('the canvas gets the screen and the explore panel is a sheet', async () => {
  const viewport = page.viewportSize()!;
  const canvas = (await page.locator('canvas').boundingBox())!;
  // The old layout gave the canvas 390 − 272 = 118 px of width.
  expect(canvas.width).toBeGreaterThan(viewport.width * 0.95);
  expect(canvas.height).toBeGreaterThan(viewport.height * 0.7);

  // The panel is parked off the bottom with only its handle showing.
  const sheet = (await page.getByLabel('explore panel').boundingBox())!;
  expect(sheet.y).toBeGreaterThan(viewport.height - 64);

  await page.getByTestId('explore-toggle').click();
  await expect.poll(sheetTop).toBeLessThan(viewport.height * 0.55);
  const open = (await page.getByLabel('explore panel').boundingBox())!;
  expect(open.width).toBeGreaterThan(viewport.width * 0.95);
  // And the search field inside it is actually on screen now.
  const search = (await page.getByTestId('node-search').boundingBox())!;
  expect(search.y + search.height).toBeLessThan(viewport.height);

  await page.getByTestId('explore-toggle').click();
  await expect.poll(sheetTop).toBeGreaterThan(viewport.height - 64);
});

test('a tap selects a node and raises the sheet', async () => {
  // Centre a known node, then tap where it now is: the tap has to survive the
  // fingertip slack, and selecting has to bring the panel up with it.
  await page.getByTestId('explore-toggle').click();
  await page.getByTestId('node-search').fill('n9999');
  await page.getByTestId('search-hit').first().click();
  await expect(page.getByTestId('selection-card').getByRole('heading')).toHaveText('n9999');
  await page.getByTestId('selection-card').getByRole('button', { name: 'clear selection' }).click();
  await page.getByTestId('explore-toggle').click();

  const canvas = (await page.locator('canvas').boundingBox())!;
  await page.touchscreen.tap(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await expect(page.getByTestId('selection-card').getByRole('heading')).toHaveText('n9999');

  const viewport = page.viewportSize()!;
  await expect.poll(sheetTop).toBeLessThan(viewport.height * 0.55);

  // A selection overflows the sheet, and the handle is a flex item in it: if it
  // is allowed to shrink, the only way back to the graph disappears.
  const handle = (await page.getByTestId('explore-toggle').boundingBox())!;
  expect(handle.height).toBeGreaterThan(30);
  await page.getByTestId('explore-toggle').click();
  await expect.poll(sheetTop).toBeGreaterThan(viewport.height - 64);
});

// Both zoom paths in one test: they assert the same property against the same
// settled view. Last in the file — it ends on a deliberate zoom-out, which is
// the one piece of state the others would notice.
test('the camera zooms — by pinch, and by button', async () => {
  const canvas = (await page.locator('canvas').boundingBox())!;
  const centre = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };

  const before = await zoomOf(page);
  await pinch(page, centre, 80, 240);
  const spread = await zoomOf(page);
  // Fingers 3× apart is a 3× zoom; allow slack for the event pipeline, but
  // nothing near 1 may pass — that is the bug this test exists for.
  expect(spread / before).toBeGreaterThan(2);

  await pinch(page, centre, 240, 80);
  const pinched = await zoomOf(page);
  expect(pinched / spread).toBeLessThan(0.5);
  expect(pinched).toBeCloseTo(before, 5);

  const fitted = await zoomOf(page);
  await page.getByRole('button', { name: 'zoom in' }).click();
  await page.getByRole('button', { name: 'zoom in' }).click();
  const zoomedIn = await zoomOf(page);
  expect(zoomedIn).toBeGreaterThan(fitted * 2);

  await page.getByRole('button', { name: 'fit graph to view' }).click();
  expect(await zoomOf(page)).toBeCloseTo(fitted, 5);

  await page.getByRole('button', { name: 'zoom out' }).click();
  expect(await zoomOf(page)).toBeLessThan(fitted);
});
