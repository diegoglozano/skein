// CPU force sim — the reference implementation of the algorithm described in
// params.ts, and the fallback when WebGPU is absent (coarse levels only; the
// caller bounds n). Sequential, flat typed arrays throughout, trivially
// deterministic.

import {
  CELL,
  CELL2,
  GRID,
  GRID2,
  WORLD_SIZE,
  stepAt,
  type LevelGraph,
  type LevelSchedule,
  type SimParams,
} from './params';

export class CpuLevelSim {
  private readonly level: LevelGraph;
  readonly positions: Float32Array;
  private readonly next: Float32Array;
  private readonly fineCount = new Uint32Array(GRID * GRID);
  private readonly fineSumX = new Float64Array(GRID * GRID);
  private readonly fineSumY = new Float64Array(GRID * GRID);
  private readonly coarseCount = new Uint32Array(GRID2 * GRID2);
  private readonly coarseSumX = new Float64Array(GRID2 * GRID2);
  private readonly coarseSumY = new Float64Array(GRID2 * GRID2);
  private readonly params: SimParams;
  private readonly schedule: LevelSchedule;
  private readonly iters: number;
  private iter = 0;

  constructor(
    level: LevelGraph,
    positions: Float32Array,
    params: SimParams,
    schedule: LevelSchedule,
    iters: number,
  ) {
    this.level = level;
    this.positions = positions;
    this.next = new Float32Array(positions.length);
    this.params = params;
    this.schedule = schedule;
    this.iters = iters;
  }

  /** One iteration; mutates `positions` in place at the end. */
  step(): void {
    const {
      level,
      positions,
      next,
      fineCount,
      fineSumX,
      fineSumY,
      coarseCount,
      coarseSumX,
      coarseSumY,
      params,
    } = this;
    const n = level.n;
    const stepSize = stepAt(this.schedule, this.iter++, this.iters);
    const kOpt = this.schedule.kOpt;
    // Degree-dissuaded attraction (ForceAtlas2's hub fix): normalise each
    // edge by the endpoint degrees, rescaled by the mean degree so
    // near-regular graphs keep the plain FR balance.
    const avgDeg = level.targets.length / Math.max(1, n);
    // Linear attraction balances repulsion k²/d² at spacing d≈kOpt when the
    // per-typical-edge coefficient is ≈kOpt; dis ≈ avgDeg for typical edges.
    const aScale = params.attractionScale * avgDeg * kOpt;
    const rScale = params.repulsionScale * kOpt * kOpt;

    fineCount.fill(0);
    fineSumX.fill(0);
    fineSumY.fill(0);
    coarseCount.fill(0);
    coarseSumX.fill(0);
    coarseSumY.fill(0);
    let rootCount = 0;
    let rootSumX = 0;
    let rootSumY = 0;
    for (let i = 0; i < n; i++) {
      const x = positions[2 * i];
      const y = positions[2 * i + 1];
      const fx = Math.min(GRID - 1, Math.max(0, Math.floor(x / CELL)));
      const fy = Math.min(GRID - 1, Math.max(0, Math.floor(y / CELL)));
      const f = fy * GRID + fx;
      fineCount[f]++;
      fineSumX[f] += x;
      fineSumY[f] += y;
      const cx = Math.min(GRID2 - 1, Math.max(0, Math.floor(x / CELL2)));
      const cy = Math.min(GRID2 - 1, Math.max(0, Math.floor(y / CELL2)));
      const c = cy * GRID2 + cx;
      coarseCount[c]++;
      coarseSumX[c] += x;
      coarseSumY[c] += y;
      rootCount++;
      rootSumX += x;
      rootSumY += y;
    }

    // Per-node subtraction entries: fine-block portions inside each coarse
    // cell (a 5-fine-cell block overlaps at most 2×2 coarse cells).
    const subIdx = new Int32Array(4);
    const subK = new Float64Array(4);
    const subX = new Float64Array(4);
    const subY = new Float64Array(4);

    for (let i = 0; i < n; i++) {
      const px = positions[2 * i];
      const py = positions[2 * i + 1];
      let fx = 0;
      let fy = 0;

      // Springs, in CSR neighbor order: linear (ForceAtlas2-style)
      // attraction, divided by √((deg_i+1)(deg_j+1)) so hubs don't collapse
      // the graph. Linear beats FR's d²/k here: stronger inside clusters,
      // far weaker across the graph's diameter.
      const degI = level.offsets[i + 1] - level.offsets[i];
      for (let e = level.offsets[i]; e < level.offsets[i + 1]; e++) {
        const j = level.targets[e];
        const w = Math.min(level.weights[e], params.weightCap);
        const degJ = level.offsets[j + 1] - level.offsets[j];
        const dis = Math.sqrt((degI + 1) * (degJ + 1));
        fx += ((positions[2 * j] - px) * aScale * w) / dis;
        fy += ((positions[2 * j + 1] - py) * aScale * w) / dis;
      }

      subIdx.fill(-1);
      subK.fill(0);
      subX.fill(0);
      subY.fill(0);

      // Near field: 5×5 fine cells, self removed from its own cell.
      const fcx = Math.min(GRID - 1, Math.max(0, Math.floor(px / CELL)));
      const fcy = Math.min(GRID - 1, Math.max(0, Math.floor(py / CELL)));
      for (let dy = -2; dy <= 2; dy++) {
        const gy = fcy + dy;
        if (gy < 0 || gy >= GRID) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const gx = fcx + dx;
          if (gx < 0 || gx >= GRID) continue;
          const c = gy * GRID + gx;
          let k = fineCount[c];
          if (k === 0) continue;
          let sx = fineSumX[c];
          let sy = fineSumY[c];
          if (dx === 0 && dy === 0) {
            k -= 1;
            sx -= px;
            sy -= py;
          }
          // Record this fine cell against its containing coarse cell.
          const ci =
            Math.floor(gy / (GRID / GRID2)) * GRID2 + Math.floor(gx / (GRID / GRID2));
          for (let s = 0; s < 4; s++) {
            if (subIdx[s] === ci || subIdx[s] === -1) {
              subIdx[s] = ci;
              subK[s] += k;
              subX[s] += sx;
              subY[s] += sy;
              break;
            }
          }
          if (k === 0) continue;
          const dxx = px - sx / k;
          const dyy = py - sy / k;
          const d2 = dxx * dxx + dyy * dyy + 0.01;
          const s = (rScale * k) / d2;
          fx += dxx * s;
          fy += dyy * s;
        }
      }

      // Mid field: 5×5 coarse cells as distinct bodies, fine block (and
      // self) subtracted exactly from the cells that contain them.
      const ccx = Math.min(GRID2 - 1, Math.max(0, Math.floor(px / CELL2)));
      const ccy = Math.min(GRID2 - 1, Math.max(0, Math.floor(py / CELL2)));
      const selfCoarse = ccy * GRID2 + ccx;
      let blockCount = 0;
      let blockSumX = 0;
      let blockSumY = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const gy = ccy + dy;
        if (gy < 0 || gy >= GRID2) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const gx = ccx + dx;
          if (gx < 0 || gx >= GRID2) continue;
          const c = gy * GRID2 + gx;
          const rawK = coarseCount[c];
          blockCount += rawK;
          blockSumX += coarseSumX[c];
          blockSumY += coarseSumY[c];
          if (rawK === 0) continue;
          let k = rawK;
          let sx = coarseSumX[c];
          let sy = coarseSumY[c];
          for (let s = 0; s < 4; s++) {
            if (subIdx[s] === c) {
              k -= subK[s];
              sx -= subX[s];
              sy -= subY[s];
            }
          }
          if (c === selfCoarse) {
            k -= 1;
            sx -= px;
            sy -= py;
          }
          if (k <= 0) continue;
          const dxx = px - sx / k;
          const dyy = py - sy / k;
          const d2 = dxx * dxx + dyy * dyy + 0.01;
          const s = (rScale * k) / d2;
          fx += dxx * s;
          fy += dyy * s;
        }
      }

      // Far field: everything beyond the coarse block, one residual body.
      const farCount = rootCount - blockCount;
      if (farCount > 0) {
        const farX = rootSumX - blockSumX;
        const farY = rootSumY - blockSumY;
        const dxx = px - farX / farCount;
        const dyy = py - farY / farCount;
        const d2 = dxx * dxx + dyy * dyy + 0.01;
        const s = (rScale * farCount) / d2;
        fx += dxx * s;
        fy += dyy * s;
      }

      // Gravity toward the world centre.
      fx += (WORLD_SIZE / 2 - px) * params.gravity;
      fy += (WORLD_SIZE / 2 - py) * params.gravity;

      // FR displacement clamp.
      const len = Math.hypot(fx, fy);
      let nx = px;
      let ny = py;
      if (len > 1e-9) {
        const d = Math.min(len, stepSize) / len;
        nx += fx * d;
        ny += fy * d;
      }
      next[2 * i] = Math.min(WORLD_SIZE, Math.max(0, nx));
      next[2 * i + 1] = Math.min(WORLD_SIZE, Math.max(0, ny));
    }

    positions.set(next);
  }
}
