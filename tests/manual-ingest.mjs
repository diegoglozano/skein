// Real-hardware ingest measurement (§9 matrix, D5 second tier): drive the
// production build's full pipeline — fetch → File → worker → WASM parse →
// CSR → OPFS — and record the app-reported stage timings.
// Usage: node manual-ingest.mjs [fixture.csv]   (preview server on :4173)
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = process.argv[2] ?? 'medium.csv';
const resultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../bench/results');
mkdirSync(resultsDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => console.error('[page error]', err.message));

await page.goto('http://localhost:4173/');
const t0 = Date.now();
const dataTransfer = await page.evaluateHandle(async (name) => {
  const blob = await (await fetch(`/fixtures/${name}`)).blob();
  const dt = new DataTransfer();
  dt.items.add(new File([blob], name, { type: 'text/csv', lastModified: 42 }));
  return dt;
}, fixture);
await page.dispatchEvent('.dropzone', 'drop', { dataTransfer });

await page.getByTestId('ingest-summary').waitFor({ timeout: 600_000 });
const wallMs = Date.now() - t0;

const summaryText = await page.getByTestId('ingest-summary').innerText();
const heap = await page.evaluate(() => {
  const m = performance.memory;
  return m ? Math.round(m.usedJSHeapSize / 1048576) : null;
});
const result = { fixture, wallMs, usedJSHeapMB: heap, summaryText };

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const out = path.join(resultsDir, `ingest-${fixture.replace(/\W+/g, '_')}-${stamp}.json`);
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(`→ ${out}`);
console.log(JSON.stringify(result, null, 2));
await browser.close();
