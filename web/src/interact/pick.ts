// Cursor → node hit-testing (§10 "node hover with attribute card").
//
// A uniform grid over the laid-out positions, same shape as the repulsion grid
// in §6: bucket counts, prefix-sum to offsets, scatter node indices. Build is
// two O(n) passes and 8 bytes per node; a query touches only the cells within
// the pick radius, so hover stays O(1)-ish at 1M nodes instead of rescanning
// the position array on every pointermove.
//
// This lives in TypeScript rather than skein-core because it is the one hot
// loop that must run on the main thread: the WASM module is instantiated in
// the ingest worker, and a hover round-trip through postMessage would lag the
// cursor by a frame or more (and stall entirely while the worker is laying
// out). Everything here is still flat typed arrays (§4.2).

/** Cells per axis is capped so the grid stays a few MB at 1M nodes. */
const MAX_CELLS_PER_AXIS = 1024;
/** Aim for ~2 nodes per cell, the usual space/scan trade for a pick grid. */
const TARGET_NODES_PER_CELL = 2;
/**
 * Cells searched either side of the cursor. The pick radius is a fixed number
 * of *screen* pixels, so in world units it grows without bound as the user
 * zooms out — unclamped, a zoomed-out hover would sweep the entire grid and
 * become the O(n) rescan this index exists to avoid. Clamped, a query touches
 * at most (2*32+1)^2 ≈ 4k cells. Zoomed out that far the cursor covers
 * thousands of nodes anyway, so "nearest within 32 cells" and "nearest
 * overall" are the same answer in every case that matters.
 */
const MAX_REACH_CELLS = 32;

export interface PickIndex {
  minX: number;
  minY: number;
  /** World units per cell. */
  cellSize: number;
  cols: number;
  rows: number;
  /** Length cols * rows + 1. */
  cellStart: Uint32Array;
  /** Node indices, grouped by cell. Length nodeCount. */
  cellNodes: Uint32Array;
}

export function buildPickIndex(positions: Float32Array): PickIndex {
  const n = positions.length >> 1;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 2) {
    if (positions[i] < minX) minX = positions[i];
    if (positions[i] > maxX) maxX = positions[i];
    if (positions[i + 1] < minY) minY = positions[i + 1];
    if (positions[i + 1] > maxY) maxY = positions[i + 1];
  }
  // All four, not just the mins: a single +Infinity coordinate leaves the mins
  // finite but makes `span` — and therefore `cellSize` — infinite, which lands
  // every node in cell 0 and turns each query back into a full scan. A NaN is
  // worse: `cellOf` yields NaN, the typed-array writes below are silently
  // dropped out of bounds, and the unscattered slots keep node 0, so hovering
  // empty space reports node 0's id.
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    minX = 0;
    minY = 0;
    maxX = 1;
    maxY = 1;
  }

  const axis = Math.max(
    1,
    Math.min(MAX_CELLS_PER_AXIS, Math.floor(Math.sqrt(n / TARGET_NODES_PER_CELL))),
  );
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const cellSize = span / axis;
  const cols = axis;
  const rows = axis;

  // Total by construction: a NaN coordinate (which the bounds check above
  // cannot catch when other coordinates are finite) must still land in a real
  // cell. Otherwise the counting and scatter passes disagree and nodes are
  // dropped into whatever slot the prefix sum left zero-initialised.
  const axisCell = (v: number, cells: number) =>
    Number.isFinite(v) ? Math.min(cells - 1, Math.max(0, Math.floor(v))) : 0;
  const cellOf = (x: number, y: number) =>
    axisCell((y - minY) / cellSize, rows) * cols + axisCell((x - minX) / cellSize, cols);

  const cellStart = new Uint32Array(cols * rows + 1);
  for (let i = 0; i < n; i++) cellStart[cellOf(positions[2 * i], positions[2 * i + 1]) + 1]++;
  for (let c = 0; c < cols * rows; c++) cellStart[c + 1] += cellStart[c];

  const cursor = cellStart.slice(0, cols * rows);
  const cellNodes = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    cellNodes[cursor[cellOf(positions[2 * i], positions[2 * i + 1])]++] = i;
  }

  return { minX, minY, cellSize, cols, rows, cellStart, cellNodes };
}

/**
 * Nearest node to (x, y) within `radius` world units, or -1. Ties break to the
 * lower node index so hover is deterministic (§6) rather than dependent on
 * scatter order.
 */
export function pickNode(
  index: PickIndex,
  positions: Float32Array,
  x: number,
  y: number,
  radius: number,
): number {
  const { minX, minY, cellSize, cols, rows, cellStart, cellNodes } = index;
  const reach = Math.min(MAX_REACH_CELLS, Math.ceil(radius / cellSize));
  const cx = Math.floor((x - minX) / cellSize);
  const cy = Math.floor((y - minY) / cellSize);

  let best = -1;
  let bestDist = radius * radius;
  for (let gy = Math.max(0, cy - reach); gy <= Math.min(rows - 1, cy + reach); gy++) {
    for (let gx = Math.max(0, cx - reach); gx <= Math.min(cols - 1, cx + reach); gx++) {
      const cell = gy * cols + gx;
      for (let s = cellStart[cell]; s < cellStart[cell + 1]; s++) {
        const node = cellNodes[s];
        const dx = positions[2 * node] - x;
        const dy = positions[2 * node + 1] - y;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist || (dist === bestDist && node < best)) {
          bestDist = dist;
          best = node;
        }
      }
    }
  }
  return best;
}
