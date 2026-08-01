// Zoom-adaptive draw budget (DECISIONS.md D13). Three properties, all of them
// things a plausible refactor breaks silently:
//
//   - at the fit view the frame is capped, and the HUD says so (no silent caps);
//   - zooming in raises the cap, because the clipped-away majority stops being
//     paid for — up to drawing the whole edge list;
//   - the cap is a pure function of the camera. The tempting implementation is
//     an fps feedback loop, which would make the picture depend on machine load
//     and quietly break §6 determinism. Two reads at a fixed camera catch it.
//
// small.csv (100k/500k) is the smallest fixture whose edge count exceeds the
// default budget, so it is the smallest one where any of this is observable.

import { test, expect } from '@playwright/test';
import { ingestAndLayout } from './helpers';

/** Matches DEFAULT_BUDGET.edges in web/src/render/lod.ts. */
const EDGE_BUDGET = 300_000;

interface Drawn {
  nodes: number;
  edges: number;
  totalNodes: number;
  totalEdges: number;
  fraction: number;
}

test('the draw budget tracks zoom and depends only on the camera', async ({ page }) => {
  test.setTimeout(300_000);
  page.on('pageerror', (err) => console.error('[page error]', err.message));

  await ingestAndLayout(page, 'small.csv');
  // The pick index exists the moment the layout settles, but the budget is
  // only recomputed on the next frame; read before that and the stats still
  // hold their pre-layout defaults.
  await page.waitForTimeout(500);

  const drawn = (): Promise<Drawn> =>
    page.evaluate(() => {
      const s = (window as any).__skeinRender;
      return {
        nodes: s.drawnNodes,
        edges: s.drawnEdges,
        totalNodes: s.nodes,
        totalEdges: s.edges,
        fraction: s.visibleFraction,
      };
    });

  const fit = await drawn();
  expect(fit.totalEdges).toBeGreaterThan(EDGE_BUDGET);
  // The whole graph is on screen, so the budget is spent as-is — D8's cap.
  expect(fit.fraction).toBeCloseTo(1, 5);
  expect(fit.edges).toBe(EDGE_BUDGET);
  await expect(page.getByTestId('draw-sample')).toBeVisible();
  // 100k nodes is under the node budget: the policy must not thin a picture
  // that fits, or every graph would render sparser than it needs to.
  expect(fit.nodes).toBe(fit.totalNodes);

  // Same camera, many frames later: bit-identical. Any temporal smoothing or
  // fps feedback shows up here.
  await page.waitForTimeout(500);
  const again = await drawn();
  expect(again.edges).toBe(fit.edges);
  expect(again.fraction).toBe(fit.fraction);

  const canvas = page.locator('canvas[aria-label="graph canvas"]');
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);

  // Zoom in: a small slice of the layout is on screen, so nearly all of the
  // submitted work would be clipped anyway — spend the headroom instead.
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -600);
  await page.waitForTimeout(500);
  const zoomed = await drawn();
  expect(zoomed.fraction).toBeLessThan(fit.fraction);
  expect(zoomed.edges).toBeGreaterThan(fit.edges);
  expect(zoomed.edges).toBe(zoomed.totalEdges); // nothing sampled away
  await expect(page.getByTestId('draw-sample')).toHaveCount(0);

  // And back out again: the cap follows the camera in both directions rather
  // than ratcheting one way.
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 600);
  await page.waitForTimeout(500);
  const back = await drawn();
  expect(back.edges).toBe(EDGE_BUDGET);
  await expect(page.getByTestId('draw-sample')).toBeVisible();
});
