// Real-hardware M4 explore measurement (D5): how long the interaction path
// actually takes at the §9 top tier. Three claims in DECISIONS.md D12 need
// numbers — the id search per keystroke, the pick per pointermove, and the
// worker neighbourhood query per click — plus post-selection pan/zoom fps,
// because the explore panel took width away from the fill-bound canvas (D8).
//
// Run HEADED — headless GL is SwiftShader (D3/D5).
// Usage: node manual-explore.mjs [fixture.csv]   (preview on :4173)
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = process.argv[2] ?? 'medium.csv';
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

const dataTransfer = await page.evaluateHandle(async (name) => {
  const blob = await (await fetch(`/fixtures/${name}`)).blob();
  const dt = new DataTransfer();
  dt.items.add(new File([blob], name, { type: 'text/csv', lastModified: 42 }));
  return dt;
}, fixture);
await page.dispatchEvent('.dropzone', 'drop', { dataTransfer });
await page.getByTestId('ingest-summary').waitFor({ timeout: 900_000 });

const openedAt = Date.now();
await page.getByRole('button', { name: 'open graph' }).click();
await page.getByTestId('graph-view').waitFor();
await page
  .getByTestId('layout-status')
  .filter({ hasText: /ready|loaded/ })
  .waitFor({ timeout: 900_000 });
const layoutWallMs = Date.now() - openedAt;

const stats = await page.evaluate(() => window.__skeinRender);
const adapterInfo = await page.evaluate(async () => {
  const adapter = await navigator.gpu?.requestAdapter();
  const info = adapter?.info;
  return info ? `${info.vendor} ${info.architecture} ${info.device}`.trim() : null;
});

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
// "finding neighbours…" also contains the word, so match a resolved count.
const RESOLVED = /[\d,]+ neighbours/;
const hook = () => page.evaluate(() => window.__skeinRender);
const max = (xs) => xs.reduce((a, b) => Math.max(a, b), 0);

// --- Search: type an id one character at a time, timing each keystroke's
// round trip to rendered results. This is the full main-thread cost — the
// dictionary scan plus React's re-render — not just the scan.
const search = page.getByTestId('node-search');
await search.click();
const searchMs = [];
const query = 'n999999';
for (let i = 0; i < query.length; i++) {
  const t0 = Date.now();
  await search.fill(query.slice(0, i + 1));
  await page.getByTestId('search-results').waitFor({ timeout: 30_000 });
  searchMs.push({ keystrokeMs: Date.now() - t0, scanMs: (await hook()).searchMs });
}
// A query that matches nothing is the worst case for an early-exit scan.
const t0Miss = Date.now();
await search.fill('zzz-no-such-node');
await page.getByTestId('search-results').filter({ hasText: 'no match' }).waitFor({
  timeout: 60_000,
});
const searchMiss = { keystrokeMs: Date.now() - t0Miss, scanMs: (await hook()).searchMs };

// --- Neighbourhood: click a search hit and wait for the worker's reply.
await search.fill(query);
await page.getByTestId('search-hit').first().waitFor({ timeout: 30_000 });
const t0Sel = Date.now();
await page.getByTestId('search-hit').first().click();
await page.getByTestId('selection-card').filter({ hasText: RESOLVED }).waitFor({
  timeout: 120_000,
});
const firstSelect = { uiMs: Date.now() - t0Sel, workerMs: (await hook()).neighborsMs };

// Follow neighbours: these hit the worker's cached CSR, so they isolate the
// query cost from the OPFS read.
const neighborSelectMs = [];
for (let i = 0; i < 5; i++) {
  const buttons = page.getByTestId('neighbor-list').getByRole('button');
  if ((await buttons.count()) === 0) break;
  const t = Date.now();
  await buttons.first().click();
  await page.getByTestId('selection-card').filter({ hasText: RESOLVED }).waitFor({
    timeout: 120_000,
  });
  neighborSelectMs.push({ uiMs: Date.now() - t, workerMs: (await hook()).neighborsMs });
}

// --- Hover: sweep the cursor across the canvas with a hub selected (the
// worst case — every pick may rewrite the overlay) and time each move.
const canvas = page.locator('canvas[aria-label="graph canvas"]');
const box = await canvas.boundingBox();
const hoverMs = [];
for (let i = 0; i < 40; i++) {
  const x = box.x + (box.width * (i + 1)) / 42;
  const y = box.y + box.height / 2 + Math.sin(i / 3) * (box.height / 4);
  await page.mouse.move(x, y);
  // The dispatch round trip is quantised to the frame period; the hook holds
  // the hit-test cost itself.
  const { pickMs } = await hook();
  if (pickMs !== null) hoverMs.push(pickMs);
}

// --- Post-selection pan/zoom fps, with the explore panel taking canvas width.
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
const fpsSamples = [];
for (let i = 0; i < 8; i++) {
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, i % 2 === 0 ? -600 : 600);
  await page.mouse.down();
  await page.mouse.move(cx + (i % 2 ? 150 : -150), cy + (i % 3 ? 100 : -100), { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1000);
  fpsSamples.push(await page.evaluate(() => window.__skeinRender.fps));
}

const heap = await page.evaluate(() => {
  const m = performance.memory;
  return m ? Math.round(m.usedJSHeapSize / 1048576) : null;
});

const result = {
  fixture,
  backend: stats.backend,
  adapterInfo,
  nodes: stats.nodes,
  edges: stats.edges,
  canvasCssPx: { width: Math.round(box.width), height: Math.round(box.height) },
  layoutWallMs,
  search: {
    perKeystroke: searchMs,
    medianScanMs: median(searchMs.map((s) => s.scanMs)),
    medianKeystrokeMs: median(searchMs.map((s) => s.keystrokeMs)),
    miss: searchMiss,
  },
  select: {
    first: firstSelect,
    followed: neighborSelectMs,
    medianWorkerMs: median(neighborSelectMs.map((s) => s.workerMs)),
  },
  pick: {
    samples: hoverMs.length,
    medianMs: median(hoverMs),
    maxMs: max(hoverMs),
  },
  panZoom: {
    fpsSamples,
    fpsMin: Math.min(...fpsSamples),
    fpsMedian: median(fpsSamples),
  },
  usedJSHeapMB: heap,
};

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const base = `explore-${fixture.replace(/\W+/g, '_')}-${stamp}`;
await page.screenshot({ path: path.join(resultsDir, `${base}.png`) });
const out = path.join(resultsDir, `${base}.json`);
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(`→ ${out}`);
console.log(JSON.stringify(result, null, 2));
await browser.close();
