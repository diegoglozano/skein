// §10 export: the current view as a PNG, and every node's coordinates as CSV.
//
// Both are built in the tab and handed over as a blob URL, so what this checks
// is that the file the browser receives is real: a PNG with the canvas's own
// dimensions (an empty drawing buffer still encodes to a valid PNG, so the
// magic bytes alone would prove nothing), and a CSV whose rows are the same
// coordinates the renderer settled on — matched against the position hash the
// determinism test uses, so a dump of the *seeded scatter* rather than the
// laid-out positions cannot pass.

import { readFile } from 'node:fs/promises';
import { test, expect, type Download, type Page } from '@playwright/test';
import { ingestAndLayout } from './helpers';

async function clickForDownload(page: Page, testId: string): Promise<Download> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(testId).click(),
  ]);
  return download;
}

test('the view exports as a PNG and the layout as coordinates', async ({ page }) => {
  test.setTimeout(180_000);
  await ingestAndLayout(page, 'tiny.csv');

  const png = await clickForDownload(page, 'export-png');
  expect(png.suggestedFilename()).toBe('tiny-seed42.png');
  const bytes = await readFile((await png.path())!);
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

  // IHDR carries width and height as big-endian u32 at bytes 16 and 20. They
  // have to match the canvas's backing store, which is what catches a capture
  // taken from a detached or zero-sized element.
  const canvas = await page.evaluate(() => {
    const el = document.querySelector('canvas[aria-label="graph canvas"]') as HTMLCanvasElement;
    return { width: el.width, height: el.height };
  });
  expect({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }).toEqual(canvas);

  const csv = await clickForDownload(page, 'export-positions');
  expect(csv.suggestedFilename()).toBe('tiny-seed42-positions.csv');
  const text = await readFile((await csv.path())!, 'utf8');

  const lines = text.trim().split('\n');
  expect(lines[0]).toBe('id,x,y');
  // `tiny` is 10,000 nodes and every one of them gets a row: the export is the
  // layout, not the draw sample or whatever the filters left visible.
  expect(lines).toHaveLength(10_001);

  const rows = lines.slice(1).map((line) => {
    const [id, x, y] = line.split(',');
    return { id, x: Number(x), y: Number(y) };
  });
  expect(rows.every((row) => Number.isFinite(row.x) && Number.isFinite(row.y))).toBe(true);
  expect(new Set(rows.map((row) => row.id)).size).toBe(10_000);

  // The coordinates have to be the ones on screen. Rebuilding the
  // Float32Array in node order and hashing it the way GraphView does
  // reproduces `positionsHash` exactly — JS prints floats by the shortest
  // round-trip rule, so Number() gives back the identical f32.
  const hash = await page.evaluate((xy: number[]) => {
    const positions = Float32Array.from(xy);
    const raw = new Uint8Array(positions.buffer);
    let h = 0x811c9dc5;
    for (let i = 0; i < raw.length; i++) {
      h ^= raw[i];
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }, rows.flatMap(({ x, y }) => [x, y]));

  const rendered = await page.evaluate(
    () =>
      (window as unknown as { __skeinRender: { positionsHash: string } }).__skeinRender
        .positionsHash,
  );
  expect(hash).toBe(rendered);
});
