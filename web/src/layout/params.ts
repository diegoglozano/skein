// Shared layout types and tuning (§6). Both engines — WGSL compute and the
// CPU reference — implement exactly this algorithm:
//
//   repulsion: two uniform grids (GRID² fine cells and GRID2² coarse cells
//     over the fixed world square). Per iteration each cell aggregates
//     {count, Σposition} — on the GPU via *integer* fixed-point atomics,
//     which are order-independent and so deterministic (D2 forbids float
//     atomics, not integer ones). Each node then reads the 5×5 fine block
//     around it (point-mass per cell, self removed), the 5×5 coarse block
//     (25 distinct mid-range bodies, with the fine block's aggregate
//     subtracted exactly from the coarse cells containing it), and one
//     residual far body (root minus the coarse block). Mid-range bodies are
//     what separates clusters — a single global far body has no direction.
//   attraction: springs along the symmetrized CSR, iterated per node in
//     neighbor order — fixed-order accumulation.
//   integration: Fruchterman–Reingold displacement clamp with exponential
//     cooling; positions clamped to the world square.
//
// Every accumulation a node performs is sequential within that node's
// thread, and cross-node sums are integers ⇒ same input + seed ⇒ same
// picture on a given machine + browser (D2).

export const WORLD_SIZE = 4096;
export const GRID = 128;
export const CELL = WORLD_SIZE / GRID;
export const GRID2 = 16;
export const CELL2 = WORLD_SIZE / GRID2;
/** Fixed-point scale for fine-cell-relative coordinates: |rel| ≤ CELL/2 = 16
 * world units → ≤1024 scaled; 2³¹/1024 ≈ 2M nodes per cell before overflow,
 * beyond the 1M tier with margin. */
export const FIXED_SCALE = 64;
/** Coarse cells are 256 world units, so |rel| ≤ 128 → ≤1024 scaled at 8;
 * again ≥2M nodes per cell before i32 overflow. */
export const FIXED_SCALE2 = 8;

export interface LevelGraph {
  n: number;
  offsets: Uint32Array;
  targets: Uint32Array;
  weights: Float32Array;
}

/** Fruchterman–Reingold-scaled parameters, dimensionless where possible:
 * attraction per edge is `w·d²/k`, repulsion per body is `c·k²/d²`, with
 * `k = kOpt = world/√n` the natural spacing computed per level. */
export interface SimParams {
  attractionScale: number;
  repulsionScale: number;
  /** Pull toward the world centre, as a fraction of distance per step unit. */
  gravity: number;
  /** Aggregated multi-edge weights are capped so hubs don't implode. */
  weightCap: number;
}

export const DEFAULT_SIM: SimParams = {
  attractionScale: 1,
  repulsionScale: 1,
  gravity: 0.03,
  weightCap: 8,
};

/** Per-level derived quantities: natural spacing and the cooling schedule. */
export interface LevelSchedule {
  kOpt: number;
  stepStart: number;
  stepEnd: number;
}

export function levelSchedule(n: number, isCoarsest: boolean): LevelSchedule {
  const kOpt = WORLD_SIZE / Math.sqrt(Math.max(1, n));
  return {
    kOpt,
    // The coarsest level starts from random scatter and needs big moves;
    // refinement levels start near-converged from prolongation.
    stepStart: isCoarsest ? WORLD_SIZE / 8 : 4 * kOpt,
    stepEnd: Math.max(0.3, 0.3 * kOpt),
  };
}

/** Exponential cooling schedule. */
export function stepAt(schedule: LevelSchedule, iter: number, iters: number): number {
  if (iters <= 1) return schedule.stepEnd;
  const t = iter / (iters - 1);
  return schedule.stepStart * Math.pow(schedule.stepEnd / schedule.stepStart, t);
}

/** mulberry32 — the project-wide seeded generator. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
