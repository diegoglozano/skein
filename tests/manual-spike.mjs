// Manual spike driver: like spike.spec.ts but with anti-throttling flags,
// phase screenshots, and JS-heap capture. Usage:
//   node manual-spike.mjs <fixture> [simCapMs] [extraChromeArg ...]
// Requires the dev server on :5173. Writes metrics + PNGs to bench/results/.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = process.argv[2] ?? 'small';
const simCapMs = process.argv[3] ?? '120000';
const extraArgs = process.argv.slice(4);
const resultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../bench/results');
mkdirSync(resultsDir, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    ...extraArgs,
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (err) => console.error('[page error]', err.message));

await page.goto(`http://localhost:5173/spike.html?fixture=${fixture}&simCapMs=${simCapMs}`);
const tag = extraArgs.length ? '-' + extraArgs.join('').replace(/[^a-z0-9]+/gi, '') : '';

// Screenshot mid-sim and at the end.
const midShot = setTimeout(async () => {
  try {
    await page.screenshot({ path: path.join(resultsDir, `spike-${fixture}${tag}-midsim.png`) });
  } catch {}
}, Number(simCapMs) / 2);

await page.waitForFunction(() => window.__spike?.done, null, { timeout: 880_000, polling: 1000 });
clearTimeout(midShot);

const metrics = await page.evaluate(() => window.__spike);
const heap = await page.evaluate(() => {
  const m = performance.memory;
  return m ? { usedJSHeapMB: Math.round(m.usedJSHeapSize / 1048576), totalJSHeapMB: Math.round(m.totalJSHeapSize / 1048576) } : null;
});
await page.screenshot({ path: path.join(resultsDir, `spike-${fixture}${tag}-final.png`) });

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const out = path.join(resultsDir, `spike-${fixture}${tag}-${stamp}.json`);
writeFileSync(out, JSON.stringify({ ...metrics, ...heap, userAgent: await page.evaluate(() => navigator.userAgent) }, null, 2));
console.log(`metrics → ${out}`);
console.log(JSON.stringify({ ...metrics, fpsDuringSim: undefined, ...heap, simFpsTail: metrics.fpsDuringSim.slice(-10) }, null, 2));
await browser.close();
