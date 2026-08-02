import { expect, type CDPSession, type Page } from '@playwright/test';

// Capture the canvas pixels for the "did this reach the framebuffer?" checks.
// This is the suite's most repeated expensive operation — thirteen calls, nine
// of them on a *styled* graph, which under SwiftShader costs ~3.4x an unstyled
// one (D14's styled WebGL2 pass draws instanced endpoint pairs). Three layers
// of cost were measured off, in order:
//
//   canvas.screenshot()      6.4 s   element capture first waits for a *stable*
//                                    bounding box, which it decides by diffing
//                                    boxes across animation frames — and this
//                                    canvas has a permanent rAF loop, so the
//                                    check pays several frames every time
//   page.screenshot({clip})  8.7 s   (same run as the two below; the numbers
//                                    move with load, the ratios do not)
//   CDP fromSurface: true    4.3 s   Playwright's own wrapper costs 2x the CDP
//                                    call it makes
//   CDP fromSurface: false   3.2 s   captures the renderer's output directly
//                                    instead of round-tripping the browser
//                                    compositor
//
// So: CDP, fromSurface false. Chromium-only, which this suite already is. The
// clip is the canvas's own bounding box, so nothing outside the canvas is
// captured and a legend appearing beside it cannot make a comparison pass.
// Verified before adopting: two captures of an unchanged canvas are
// byte-identical, and a colour-by still changes them.
const sessions = new WeakMap<Page, Promise<CDPSession>>();

export async function canvasPixels(page: Page): Promise<Buffer> {
  const box = (await page.locator('canvas[aria-label="graph canvas"]').boundingBox())!;
  let session = sessions.get(page);
  if (!session) {
    session = page.context().newCDPSession(page);
    sessions.set(page, session);
  }
  const { data } = await (
    await session
  ).send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: false,
    clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
  });
  return Buffer.from(data, 'base64');
}

// Build a File from a same-origin fixture and drop it on the dropzone.
// lastModified is pinned so the OPFS graph id is deterministic across runs.
export async function dropFixture(page: Page, fixture: string): Promise<void> {
  const dataTransfer = await page.evaluateHandle(async (name) => {
    const blob = await (await fetch(`/fixtures/${name}`)).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], name, { type: 'text/csv', lastModified: 42 }));
    return dt;
  }, fixture);
  await page.dispatchEvent('.dropzone', 'drop', { dataTransfer });
}

// Generate a sample graph of the requested size in the app itself — the path a
// device with no data on it takes.
export async function generateSample(page: Page, nodes: number, edges: number): Promise<void> {
  await page.getByTestId('generate-nodes').fill(String(nodes));
  await page.getByTestId('generate-edges').fill(String(edges));
  await page.getByTestId('generate-run').click();
}

// As `ingestAndLayout`, but the graph is synthesized in the tab instead of
// dropped, so the hash the two return is comparable.
export async function generateAndLayout(
  page: Page,
  nodes: number,
  edges: number,
): Promise<string> {
  await page.goto('/');
  await generateSample(page, nodes, edges);
  await expect(page.getByTestId('ingest-summary')).toBeVisible({ timeout: 120_000 });
  await page.getByRole('button', { name: 'open graph' }).click();
  await expect(page.getByTestId('layout-status')).toContainText(/ready|loaded/, {
    timeout: 120_000,
  });
  const hash = await page.evaluate(() => (window as any).__skeinRender.positionsHash as string);
  expect(hash).toBeTruthy();
  return hash;
}

// Ingest a fixture, open the graph view, wait for the M3 layout to settle
// (computed or loaded from OPFS), and return the deterministic position hash.
export async function ingestAndLayout(page: Page, fixture: string): Promise<string> {
  await page.goto('/');
  await dropFixture(page, fixture);
  await expect(page.getByTestId('ingest-summary')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'open graph' }).click();
  await expect(page.getByTestId('layout-status')).toContainText(/ready|loaded/, {
    timeout: 120_000,
  });
  const hash = await page.evaluate(() => (window as any).__skeinRender.positionsHash as string);
  expect(hash).toBeTruthy();
  return hash;
}
