// Real-hardware M2 render measurement: ingest a fixture through the app,
// open the graph view, run scripted pan/zoom, and record fps from the
// __skeinRender hook. Run HEADED — headless GL is SwiftShader (D3/D5).
// Usage: node manual-render.mjs [fixture.csv] [seconds]   (preview on :4173)
//
// Also sweeps zoom levels in both directions and reports fps against the draw
// budget at each one (D13). That table is the calibration input for
// DEFAULT_BUDGET in web/src/render/lod.ts, and `sweepMinFps` is the number that
// has to clear §9's floor — the fit view alone is not the worst frame, in
// either direction. To recalibrate `maxEdges`, rebuild once per candidate and
// take the sweep minimum; see bench/results/lod-calibration-*.json.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = process.argv[2] ?? 'medium.csv';
const seconds = Number(process.argv[3] ?? 20);
const resultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../bench/results');
mkdirSync(resultsDir, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (err) => console.error('[page error]', err.message));

await page.goto('http://localhost:4173/');

// Ingest, then open the render view.
const dataTransfer = await page.evaluateHandle(async (name) => {
  const blob = await (await fetch(`/fixtures/${name}`)).blob();
  const dt = new DataTransfer();
  dt.items.add(new File([blob], name, { type: 'text/csv', lastModified: 42 }));
  return dt;
}, fixture);
await page.dispatchEvent('.dropzone', 'drop', { dataTransfer });
await page.getByTestId('ingest-summary').waitFor({ timeout: 600_000 });
await page.getByRole('button', { name: 'open graph' }).click();
await page.getByTestId('graph-view').waitFor();
await page.waitForFunction(() => (window.__skeinRender?.frames ?? 0) > 5, null, {
  timeout: 60_000,
});

const adapterInfo = await page.evaluate(async () => {
  const adapter = await navigator.gpu?.requestAdapter();
  const info = adapter?.info;
  return info ? `${info.vendor} ${info.architecture} ${info.device}`.trim() : null;
});

// Scripted interaction: zoom oscillation + drags, sampling fps each second.
const canvas = page.locator('canvas[aria-label="graph canvas"]');
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
const fpsSamples = [];
const deadline = Date.now() + seconds * 1000;
let i = 0;
while (Date.now() < deadline) {
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, i % 2 === 0 ? -600 : 600);
  await page.mouse.down();
  await page.mouse.move(cx + (i % 2 ? 150 : -150), cy + (i % 3 ? 100 : -100), { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1000);
  fpsSamples.push(await page.evaluate(() => window.__skeinRender.fps));
  i++;
}

// Zoom sweep: hold a camera, let fps settle, record what the budget spent.
//
// Three things this has to get right, each of which the first version of it got
// wrong and which cost a calibration run to find:
//
//   - **Start from the fit view.** The pan/zoom loop above leaves the camera
//     wherever it finished, so "notches from the fit view" is a lie unless the
//     sweep resets first. Zoom is relative and there is no absolute setter, so
//     reset by stepping back exactly as far as we stepped out.
//   - **Sweep both directions.** The interesting frames are on both sides: the
//     zoom-out overdraw collapse and the zoom-in trough one notch inside fit.
//     A one-directional sweep reports the fit view as the worst frame, which is
//     the conclusion D13 drew and which is wrong.
//   - **Small steps.** deltaY 600 is a 3.3x zoom per notch, which jumps clean
//     over the trough — the first sweep sampled 60 fps on both sides of a 5 fps
//     frame and reported everything as fine. 200 (1.49x) resolves it.
const NOTCH = 200;
const sweepAt = async (notches) => {
  await page.mouse.move(cx, cy);
  for (let n = 0; n < Math.abs(notches); n++) {
    await page.mouse.wheel(0, notches > 0 ? -NOTCH : NOTCH);
  }
  // Two full fps windows: the first is polluted by the frames spent zooming.
  await page.waitForTimeout(2200);
  const at = await page.evaluate(() => {
    const s = window.__skeinRender;
    return {
      fps: s.fps,
      drawnNodes: s.drawnNodes,
      drawnEdges: s.drawnEdges,
      visibleFraction: s.visibleFraction,
      coverage: s.coverage,
    };
  });
  return { ...at, onScreenEdges: Math.round(at.drawnEdges * at.visibleFraction) };
};

const zoomLevels = [];
// Out from fit, one notch at a time, then all the way back.
zoomLevels.push({ notches: 0, ...(await sweepAt(0)) });
for (let step = 1; step <= 8; step++) {
  zoomLevels.push({ notches: -step, ...(await sweepAt(-1)) });
}
await sweepAt(8);
// ...and in from fit, likewise.
zoomLevels.push({ notches: 0, ...(await sweepAt(0)) });
for (let step = 1; step <= 8; step++) {
  zoomLevels.push({ notches: step, ...(await sweepAt(1)) });
}
const sweepMinFps = Math.min(...zoomLevels.map((z) => z.fps));

const stats = await page.evaluate(() => window.__skeinRender);
const heap = await page.evaluate(() => {
  const m = performance.memory;
  return m ? Math.round(m.usedJSHeapSize / 1048576) : null;
});
const sorted = [...fpsSamples].sort((a, b) => a - b);
const result = {
  fixture,
  backend: stats.backend,
  adapterInfo,
  nodes: stats.nodes,
  edges: stats.edges,
  fpsSamples,
  fpsMin: sorted[0],
  fpsMedian: sorted[Math.floor(sorted.length / 2)],
  zoomLevels,
  // The number the budget is actually calibrated against: §9's floor has to
  // hold at every camera, not just at the fit view.
  sweepMinFps,
  usedJSHeapMB: heap,
};

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
await page.screenshot({
  path: path.join(resultsDir, `render-${fixture.replace(/\W+/g, '_')}-${stamp}.png`),
});
const out = path.join(resultsDir, `render-${fixture.replace(/\W+/g, '_')}-${stamp}.json`);
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(`→ ${out}`);
console.log(JSON.stringify(result, null, 2));
await browser.close();
