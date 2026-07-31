// Multilevel layout orchestration (§6): lay out the coarsest level with a
// long sim, prolongate down (parent position + seeded jitter), refine each
// finer level with a shrinking iteration budget. Runs the GPU engine when a
// device is provided; otherwise the CPU reference handles levels up to a
// size bound and finer levels get prolongation only (§8 graceful
// degradation — the WebGL2 tier keeps a usable, deterministic picture).

import { CpuLevelSim } from './cpu';
import { GpuLevelSim } from './gpu';
import {
  DEFAULT_SIM,
  WORLD_SIZE,
  levelSchedule,
  mulberry32,
  type LevelGraph,
  type SimParams,
} from './params';
import type { HierarchyLevelBuffers } from '../workers/protocol';

/** Iteration budget per level, coarsest first. */
const COARSEST_ITERS = 300;
const MIN_ITERS = 40;
/** CPU fallback refines levels only up to this many nodes. */
const CPU_MAX_NODES = 150_000;
/** Yield to the event loop (and the render loop) every this many iterations. */
const YIELD_EVERY = 4;

export interface LayoutProgress {
  level: number;
  levels: number;
  iter: number;
  iters: number;
  nodes: number;
}

export interface LayoutOptions {
  seed: number;
  device?: GPUDevice;
  params?: SimParams;
  /** Called on yield points; return false to cancel. */
  onProgress?: (p: LayoutProgress) => boolean;
  /** Called on yield points with a live view of current positions. */
  onPositions?: (positions: Float32Array | GpuLevelSim, nodeCount: number) => void;
}

function toLevelGraph(l: HierarchyLevelBuffers): LevelGraph {
  return { n: l.offsets.length - 1, offsets: l.offsets, targets: l.targets, weights: l.weights };
}

function seedCoarsest(n: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const xy = new Float32Array(2 * n);
  const c = WORLD_SIZE / 2;
  const r = WORLD_SIZE / 4;
  for (let i = 0; i < n; i++) {
    // Uniform disc, deterministic.
    const a = rand() * 2 * Math.PI;
    const d = Math.sqrt(rand()) * r;
    xy[2 * i] = c + Math.cos(a) * d;
    xy[2 * i + 1] = c + Math.sin(a) * d;
  }
  return xy;
}

function prolongate(
  coarsePos: Float32Array,
  parentMap: Uint32Array,
  coarseN: number,
  seed: number,
  levelIndex: number,
): Float32Array {
  const n = parentMap.length;
  const rand = mulberry32((seed ^ (levelIndex * 0x9e3779b9)) >>> 0);
  const jitter = (0.5 * WORLD_SIZE) / Math.sqrt(Math.max(1, coarseN));
  const xy = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    const p = parentMap[i];
    xy[2 * i] = coarsePos[2 * p] + (rand() - 0.5) * jitter;
    xy[2 * i + 1] = coarsePos[2 * p + 1] + (rand() - 0.5) * jitter;
  }
  return xy;
}

const nextFrame = () =>
  new Promise<void>((r) =>
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 0),
  );

/**
 * Run the full multilevel layout. `levels[0]` is the finest (symmetrized)
 * graph. Resolves with final fine positions, or null if cancelled.
 */
export async function multilevelLayout(
  levels: HierarchyLevelBuffers[],
  options: LayoutOptions,
): Promise<Float32Array | null> {
  const params = options.params ?? DEFAULT_SIM;
  const count = levels.length;
  let positions = seedCoarsest(levels[count - 1].offsets.length - 1, options.seed);

  for (let li = count - 1; li >= 0; li--) {
    const level = toLevelGraph(levels[li]);
    // Coarsest gets the long sim; budgets halve as levels grow finer.
    let iters = Math.max(MIN_ITERS, COARSEST_ITERS >> (count - 1 - li));
    const useGpu = options.device !== undefined;
    if (!useGpu && level.n > CPU_MAX_NODES) {
      iters = 0; // prolongation only — CPU can't afford this level
    }

    const schedule = levelSchedule(level.n, li === count - 1);
    if (iters > 0 && useGpu) {
      const sim = new GpuLevelSim(options.device!, level, positions, params, schedule, iters);
      try {
        for (let it = 0; it < iters; it++) {
          sim.step();
          if ((it + 1) % YIELD_EVERY === 0 || it === iters - 1) {
            options.onPositions?.(sim, level.n);
            await nextFrame();
            const go = options.onProgress?.({
              level: count - li,
              levels: count,
              iter: it + 1,
              iters,
              nodes: level.n,
            });
            if (go === false) return null;
          }
        }
        positions = await sim.read();
      } finally {
        sim.dispose();
      }
    } else if (iters > 0) {
      const sim = new CpuLevelSim(level, positions, params, schedule, iters);
      for (let it = 0; it < iters; it++) {
        sim.step();
        if ((it + 1) % YIELD_EVERY === 0 || it === iters - 1) {
          options.onPositions?.(sim.positions, level.n);
          await nextFrame();
          const go = options.onProgress?.({
            level: count - li,
            levels: count,
            iter: it + 1,
            iters,
            nodes: level.n,
          });
          if (go === false) return null;
        }
      }
      positions = sim.positions;
    }

    if (li > 0) {
      const finer = levels[li - 1];
      positions = prolongate(
        positions,
        finer.parentMap!,
        level.n,
        options.seed,
        li,
      );
    }
  }
  return positions;
}
