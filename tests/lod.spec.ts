// Zoom-adaptive draw budget (DECISIONS.md D13, corrected by the 2026-08-01
// calibration in bench/results/lod-calibration-medium_csv-2026-08-01.json).
// Four properties, all of them things a plausible refactor breaks silently:
//
//   - at the fit view the frame is capped at exactly D8's number, and the HUD
//     says so (no silent caps). This is the frame the budget was measured on,
//     so it is the one that must come out unscaled;
//   - zooming *out* lowers the cap. This is the regression test for the
//     measured collapse — 1M unshrinking, alpha-blended node quads packing onto
//     a shrinking patch of screen took the 1M tier from 57 fps to 7.8 while the
//     drawn counts and `visibleFraction` stayed bit-identical, because `f`
//     saturates at 1 exactly where the problem starts;
//   - zooming in does *not* raise the edge cap. D13 originally prescribed the
//     opposite; edges are lines whose on-screen pixel length grows with zoom,
//     so the headroom it assumed was never there, and at this tier the ceiling
//     equals the base budget;
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
  coverage: number;
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
        coverage: s.coverage,
      };
    });

  const fit = await drawn();
  expect(fit.totalEdges).toBeGreaterThan(EDGE_BUDGET);
  // The whole graph is on screen and covers exactly its fit-view area, so both
  // terms are 1 and the budget is spent as-is — D8's cap.
  expect(fit.fraction).toBeCloseTo(1, 5);
  expect(fit.coverage).toBeCloseTo(1, 5);
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
  expect(again.coverage).toBe(fit.coverage);

  const canvas = page.locator('canvas[aria-label="graph canvas"]');
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);

  // Zoom out: the layout shrinks below the viewport, so the same node quads
  // would pile onto fewer and fewer pixels. `coverage` is the only term that
  // can see this — `fraction` is pinned at 1 throughout, which is precisely
  // why the collapse went unnoticed.
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 200);
  await page.waitForTimeout(500);
  const out = await drawn();
  expect(out.fraction).toBeCloseTo(1, 5);
  expect(out.coverage).toBeLessThan(fit.coverage);
  expect(out.nodes).toBeLessThan(fit.nodes);
  expect(out.edges).toBeLessThan(fit.edges);

  // Back to the fit view: the cap follows the camera in both directions rather
  // than ratcheting one way.
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -200);
  await page.waitForTimeout(500);
  const back = await drawn();
  expect(back.edges).toBe(EDGE_BUDGET);
  expect(back.coverage).toBeCloseTo(1, 5);
  await expect(page.getByTestId('draw-sample')).toBeVisible();

  // Zoom in: coverage rises above 1 and the fraction falls, but the edge count
  // must not climb past the ceiling — that is the correction the calibration
  // forced, and the assertion that fails if someone restores D13's original
  // "spend the headroom" rule.
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -200);
  await page.waitForTimeout(500);
  const zoomed = await drawn();
  expect(zoomed.coverage).toBeGreaterThan(1);
  expect(zoomed.fraction).toBeLessThan(fit.fraction);
  expect(zoomed.edges).toBeLessThanOrEqual(EDGE_BUDGET);
});
