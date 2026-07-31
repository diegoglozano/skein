// Records the README demo: drop a CSV, watch the multilevel layout converge,
// pan and zoom the result. Runs HEADED against the preview server so the
// capture shows the real WebGPU path (headless is SwiftShader — D3/D5), then
// converts Playwright's webm to a palette-optimised GIF with ffmpeg.
// Usage: node tests/manual-demo.mjs [fixture.csv] [out.gif]   (preview on :4173)
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = process.argv[2] ?? 'clustered.csv';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outGif = path.resolve(process.argv[3] ?? path.join(root, 'docs/demo.gif'));

// GIF knobs. A moving field of 20k bright points is close to worst case for
// GIF — every pixel changes every frame, so inter-frame compression has
// nothing to work with and size scales with frames × area. Measured on this
// clip: colour depth and dither mode are worth ~10% each, duration and area
// are worth everything. Hence a short clip, 720px, few colours, and gifsicle's
// lossy pass — together about 4 MB for 13 s.
const WIDTH = 1280;
const HEIGHT = 800;
const GIF_WIDTH = 720;
const GIF_FPS = 10;
const GIF_COLORS = 48;
const GIF_LOSSY = 80;

const videoDir = mkdtempSync(path.join(tmpdir(), 'skein-demo-'));
const browser = await chromium.launch({
  headless: false,
  args: [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
});
// A fresh context means empty OPFS, so the layout is computed on camera
// rather than loaded from storage.
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  recordVideo: { dir: videoDir, size: { width: WIDTH, height: HEIGHT } },
});
const page = await context.newPage();
page.on('pageerror', (err) => console.error('[page error]', err.message));

const beat = (ms) => page.waitForTimeout(ms);

await page.goto('http://localhost:4173/');
await page.locator('.dropzone').waitFor();
await beat(1200);

// Drop the fixture — dragover first so the drop zone lights up on camera.
const dataTransfer = await page.evaluateHandle(async (name) => {
  const blob = await (await fetch(`/fixtures/${name}`)).blob();
  const dt = new DataTransfer();
  dt.items.add(new File([blob], name, { type: 'text/csv', lastModified: 42 }));
  return dt;
}, fixture);
await page.dispatchEvent('.dropzone', 'dragover', { dataTransfer });
await beat(600);
await page.dispatchEvent('.dropzone', 'drop', { dataTransfer });

await page.getByTestId('ingest-summary').waitFor({ timeout: 600_000 });
await beat(1800); // the summary card: node/edge counts and stage timings
await page.getByRole('button', { name: 'open graph' }).click();
await page.getByTestId('graph-view').waitFor();

// The layout converging is the shot worth having; hold on it after it lands.
await page.getByTestId('layout-status').filter({ hasText: /ready|loaded/ }).waitFor({
  timeout: 600_000,
});
await beat(1000);

const canvas = page.locator('canvas[aria-label="graph canvas"]');
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

// Zoom is exponential in wheel delta (Camera.zoomAt: e^-0.002Δ), so a step of
// -80 is ×1.17 and five of them ×2.2. Deeper than that on this fixture lands
// between clusters and the frame just looks empty. Zoom out with the same
// total delta to land back on the framing the layout chose.
const ZOOM_STEP = 80;
const ZOOM_STEPS = 5;

/** Wheel zoom in small steps — one big delta reads as a jump cut. */
async function zoom(x, y, delta, steps) {
  await page.mouse.move(x, y);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, delta);
    await beat(45);
  }
}

/** Press-drag-release with enough intermediate points to look like a hand. */
async function pan(fromX, fromY, toX, toY) {
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(toX, toY, { steps: 40 });
  await page.mouse.up();
}

// Zoom into a point that has graph under it, drift across the detail, come back.
const focusX = cx - 140;
const focusY = cy - 70;
await zoom(focusX, focusY, -ZOOM_STEP, ZOOM_STEPS);
await beat(600);
await pan(cx + 120, cy + 90, cx - 60, cy - 40);
await beat(400);
await pan(cx - 100, cy - 30, cx + 100, cy + 70);
await beat(500);
await zoom(focusX, focusY, ZOOM_STEP, ZOOM_STEPS);
await beat(1200);

const stats = await page.evaluate(() => ({ ...window.__skeinRender }));
await context.close(); // flushes the video
await browser.close();

const webm = readdirSync(videoDir)
  .filter((f) => f.endsWith('.webm'))
  .map((f) => path.join(videoDir, f))[0];
if (!webm) throw new Error(`no video written to ${videoDir}`);

// Two-pass palette: one shared palette for the clip beats per-frame quantising
// on both size and banding.
mkdirSync(path.dirname(outGif), { recursive: true });
const filters =
  `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];` +
  `[a]palettegen=max_colors=${GIF_COLORS}:stats_mode=diff[p];` +
  `[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`;
execFileSync('ffmpeg', ['-y', '-i', webm, '-lavfi', filters, '-loop', '0', outGif], {
  stdio: ['ignore', 'ignore', 'inherit'],
});

// Optional but worth ~35%: gifsicle's lossy pass tolerates small per-pixel
// error to keep LZW runs going, which suits a noisy point cloud.
try {
  execFileSync('gifsicle', ['-O3', `--lossy=${GIF_LOSSY}`, outGif, '-o', outGif], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
} catch {
  console.warn('gifsicle not found — the GIF is ~35% larger than it needs to be');
}

console.log(JSON.stringify({ fixture, ...stats }, null, 2));
console.log(`→ ${outGif} (${(statSync(outGif).size / 1048576).toFixed(1)} MB)`);
// Kept so the encode can be retuned without re-recording; it is in the OS
// temp dir, so it goes away on its own.
console.log(`  source video: ${webm}`);
