// Real-hardware measurement of the no-WebGPU layout tier (DECISIONS.md D11):
// hide `navigator.gpu`, ingest a fixture, and time the WASM multilevel layout
// running inside the ingest worker. Records per-level durations (scraped from
// the layout status line) so the node cap can be set from numbers rather than
// guessed. Run HEADED (D3/D5) against the preview server on :4173.
// Usage: node manual-layout-fallback.mjs [fixture.csv] [panZoomSeconds]
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = process.argv[2] ?? 'small.csv';
const seconds = Number(process.argv[3] ?? 6);
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

// Force the fallback tier before any page script runs.
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
});
// Sample the layout status so each level's wall time is recoverable.
await page.addInitScript(() => {
  window.__levelLog = [];
  setInterval(() => {
    const state = window.__skeinRender?.layoutState;
    if (state === undefined) return;
    const last = window.__levelLog[window.__levelLog.length - 1];
    const level = /level (\d+)\/(\d+)/.exec(state);
    const key = level ? `${level[1]}/${level[2]}` : state;
    if (!last || last.key !== key) window.__levelLog.push({ key, t: performance.now(), state });
    else last.until = performance.now();
  }, 20);
});

await page.goto('http://localhost:4173/');
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

await page.getByTestId('layout-status').filter({ hasText: /ready|loaded/ }).waitFor({
  timeout: 600_000,
});
const layout = await page.evaluate(() => ({
  backend: window.__skeinRender.backend,
  layoutMs: window.__skeinRender.layoutMs,
  positionsHash: window.__skeinRender.positionsHash,
  nodes: window.__skeinRender.nodes,
  edges: window.__skeinRender.edges,
  levelLog: window.__levelLog,
}));
if (layout.backend !== 'webgl2') {
  console.warn(`! backend is ${layout.backend}, not the fallback tier`);
}

// Turn the status samples into per-phase durations.
const phases = layout.levelLog.map((entry, i) => {
  const end = layout.levelLog[i + 1]?.t ?? entry.until ?? entry.t;
  return { phase: entry.key, secs: Math.round(end - entry.t) / 1000, sample: entry.state };
});

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const slug = fixture.replace(/\W+/g, '_');
await page.screenshot({ path: path.join(resultsDir, `layout-fallback-${slug}-${stamp}.png`) });

// Post-layout pan/zoom fps on the WebGL2 renderer.
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
const heap = await page.evaluate(() => {
  const m = performance.memory;
  return m ? Math.round(m.usedJSHeapSize / 1048576) : null;
});
const sorted = [...fpsSamples].sort((a, b) => a - b);
const result = {
  fixture,
  tier: 'no-webgpu (wasm layout in worker)',
  backend: layout.backend,
  nodes: layout.nodes,
  edges: layout.edges,
  positionsHash: layout.positionsHash,
  layoutMs: layout.layoutMs,
  layoutSecs: layout.layoutMs === null ? null : Math.round(layout.layoutMs / 100) / 10,
  phases,
  fpsMin: sorted[0] ?? null,
  fpsMedian: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
  usedJSHeapMB: heap,
};
const out = path.join(resultsDir, `layout-fallback-${slug}-${stamp}.json`);
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(`→ ${out}`);
console.log(JSON.stringify(result, null, 2));
await browser.close();
