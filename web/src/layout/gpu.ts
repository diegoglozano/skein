// WebGPU compute force sim — same algorithm as cpu.ts (see params.ts for the
// scheme and the determinism argument). Cross-node grid aggregation uses
// integer fixed-point atomics (order-independent ⇒ deterministic, D2); every
// float accumulation happens sequentially inside one node's thread.
//
// Grid aggregates pack into one atomic<i32> array per grid ([count, sumX,
// sumY] triplets) to stay inside WebGPU's base limit of 8 storage buffers
// per stage.

import {
  CELL,
  CELL2,
  FIXED_SCALE,
  FIXED_SCALE2,
  GRID,
  GRID2,
  WORLD_SIZE,
  stepAt,
  type LevelGraph,
  type LevelSchedule,
  type SimParams,
} from './params';

const SHADER = /* wgsl */ `
struct Params {
  n: u32,
  step: f32,
  aScale: f32,     // attractionScale * avgDeg * kOpt
  rScale: f32,     // repulsionScale * kOpt²
  gravity: f32,
  weightCap: f32,
  _pad0: f32,
  _pad1: f32,
}

const WORLD: f32 = ${WORLD_SIZE};
const GRID: i32 = ${GRID};
const CELL: f32 = ${CELL};
const SCALE: f32 = ${FIXED_SCALE};
const CELLS: u32 = ${GRID * GRID}u;
const GRID2: i32 = ${GRID2};
const CELL2: f32 = ${CELL2};
const SCALE2: f32 = ${FIXED_SCALE2};
const CELLS2: u32 = ${GRID2 * GRID2}u;
const FPC: i32 = ${GRID / GRID2}; // fine cells per coarse cell

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> posIn: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> posOut: array<vec2f>;
// [count, sumX, sumY] per cell, fixed-point relative to the cell centre.
@group(0) @binding(3) var<storage, read_write> fineGrid: array<atomic<i32>>;
@group(0) @binding(4) var<storage, read_write> coarseGrid: array<atomic<i32>>;
@group(0) @binding(5) var<storage, read> offsets: array<u32>;
@group(0) @binding(6) var<storage, read> targets: array<u32>;
@group(0) @binding(7) var<storage, read> weights: array<f32>;
// root: [count, sumX, sumY] as f32 — written by one sequential thread.
@group(0) @binding(8) var<storage, read_write> root: array<f32>;

fn fineCellOf(p: vec2f) -> vec2i {
  return clamp(vec2i(p / CELL), vec2i(0), vec2i(GRID - 1));
}
fn coarseCellOf(p: vec2f) -> vec2i {
  return clamp(vec2i(p / CELL2), vec2i(0), vec2i(GRID2 - 1));
}
fn fineCenter(c: vec2i) -> vec2f {
  return (vec2f(c) + 0.5) * CELL;
}
fn coarseCenter(c: vec2i) -> vec2f {
  return (vec2f(c) + 0.5) * CELL2;
}

@compute @workgroup_size(256)
fn clearGrid(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i < 3u * CELLS) {
    atomicStore(&fineGrid[i], 0);
  }
  if (i < 3u * CELLS2) {
    atomicStore(&coarseGrid[i], 0);
  }
}

@compute @workgroup_size(256)
fn aggregate(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let p = posIn[i];
  let fc = fineCellOf(p);
  let fi = u32(fc.y * GRID + fc.x);
  let frel = (p - fineCenter(fc)) * SCALE;
  atomicAdd(&fineGrid[3u * fi], 1);
  atomicAdd(&fineGrid[3u * fi + 1u], i32(round(frel.x)));
  atomicAdd(&fineGrid[3u * fi + 2u], i32(round(frel.y)));
  let cc = coarseCellOf(p);
  let ci = u32(cc.y * GRID2 + cc.x);
  let crel = (p - coarseCenter(cc)) * SCALE2;
  atomicAdd(&coarseGrid[3u * ci], 1);
  atomicAdd(&coarseGrid[3u * ci + 1u], i32(round(crel.x)));
  atomicAdd(&coarseGrid[3u * ci + 2u], i32(round(crel.y)));
}

// Single sequential thread: fixed order ⇒ deterministic float sums.
@compute @workgroup_size(1)
fn reduceRoot() {
  var count = 0.0;
  var sum = vec2f(0.0);
  for (var c = 0u; c < CELLS2; c++) {
    let k = f32(atomicLoad(&coarseGrid[3u * c]));
    if (k == 0.0) { continue; }
    let rel = vec2f(
      f32(atomicLoad(&coarseGrid[3u * c + 1u])),
      f32(atomicLoad(&coarseGrid[3u * c + 2u])),
    ) / SCALE2;
    let center = coarseCenter(vec2i(i32(c) % GRID2, i32(c) / GRID2));
    sum += rel + center * k;
    count += k;
  }
  root[0] = count;
  root[1] = sum.x;
  root[2] = sum.y;
}

@compute @workgroup_size(256)
fn forces(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let p = posIn[i];
  var f = vec2f(0.0);

  // Springs, in CSR neighbor order: linear (ForceAtlas2-style) attraction,
  // divided by √((deg_i+1)(deg_j+1)) so hubs don't collapse the graph.
  // Linear beats FR's d²/k here: stronger inside clusters, far weaker
  // across the graph's diameter.
  let start = offsets[i];
  let end = offsets[i + 1u];
  let degI = f32(end - start);
  for (var e = start; e < end; e++) {
    let j = targets[e];
    let degJ = f32(offsets[j + 1u] - offsets[j]);
    let d = posIn[j] - p;
    let dis = sqrt((degI + 1.0) * (degJ + 1.0));
    f += d * (P.aScale * min(weights[e], P.weightCap) / dis);
  }

  // Fine-block portions per containing coarse cell (≤ 2×2 coarse cells).
  var subIdx = array<i32, 4>(-1, -1, -1, -1);
  var subK = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
  var subS = array<vec2f, 4>(vec2f(0.0), vec2f(0.0), vec2f(0.0), vec2f(0.0));

  // Near field: 5×5 fine cells, self removed from its own cell.
  let fc = fineCellOf(p);
  for (var dy = -2; dy <= 2; dy++) {
    let gy = fc.y + dy;
    if (gy < 0 || gy >= GRID) { continue; }
    for (var dx = -2; dx <= 2; dx++) {
      let gx = fc.x + dx;
      if (gx < 0 || gx >= GRID) { continue; }
      let c = u32(gy * GRID + gx);
      var k = f32(atomicLoad(&fineGrid[3u * c]));
      if (k == 0.0) { continue; }
      let rel = vec2f(
        f32(atomicLoad(&fineGrid[3u * c + 1u])),
        f32(atomicLoad(&fineGrid[3u * c + 2u])),
      ) / SCALE;
      var s = rel + fineCenter(vec2i(gx, gy)) * k;
      if (dx == 0 && dy == 0) {
        k -= 1.0;
        s -= p;
      }
      let ci = (gy / FPC) * GRID2 + (gx / FPC);
      for (var t = 0; t < 4; t++) {
        if (subIdx[t] == ci || subIdx[t] == -1) {
          subIdx[t] = ci;
          subK[t] += k;
          subS[t] += s;
          break;
        }
      }
      if (k <= 0.0) { continue; }
      let d = p - s / k;
      let d2 = dot(d, d) + 0.01;
      f += d * (P.rScale * k / d2);
    }
  }

  // Mid field: 5×5 coarse cells as distinct bodies, fine block and self
  // subtracted exactly from the cells containing them.
  let cc = coarseCellOf(p);
  let selfCoarse = cc.y * GRID2 + cc.x;
  var blockCount = 0.0;
  var blockSum = vec2f(0.0);
  for (var dy = -2; dy <= 2; dy++) {
    let gy = cc.y + dy;
    if (gy < 0 || gy >= GRID2) { continue; }
    for (var dx = -2; dx <= 2; dx++) {
      let gx = cc.x + dx;
      if (gx < 0 || gx >= GRID2) { continue; }
      let ci = gy * GRID2 + gx;
      let c = u32(ci);
      let rawK = f32(atomicLoad(&coarseGrid[3u * c]));
      let rel = vec2f(
        f32(atomicLoad(&coarseGrid[3u * c + 1u])),
        f32(atomicLoad(&coarseGrid[3u * c + 2u])),
      ) / SCALE2;
      let rawS = rel + coarseCenter(vec2i(gx, gy)) * rawK;
      blockCount += rawK;
      blockSum += rawS;
      if (rawK == 0.0) { continue; }
      var k = rawK;
      var s = rawS;
      for (var t = 0; t < 4; t++) {
        if (subIdx[t] == ci) {
          k -= subK[t];
          s -= subS[t];
        }
      }
      if (ci == selfCoarse) {
        k -= 1.0;
        s -= p;
      }
      if (k <= 0.0) { continue; }
      let d = p - s / k;
      let d2 = dot(d, d) + 0.01;
      f += d * (P.rScale * k / d2);
    }
  }

  // Far field: everything beyond the coarse block, one residual body.
  let farCount = root[0] - blockCount;
  if (farCount > 0.5) {
    let far = vec2f(root[1], root[2]) - blockSum;
    let d = p - far / farCount;
    let d2 = dot(d, d) + 0.01;
    f += d * (P.rScale * farCount / d2);
  }

  // Gravity toward the world centre.
  f += (vec2f(WORLD * 0.5) - p) * P.gravity;

  // FR displacement clamp.
  let len = length(f);
  var np = p;
  if (len > 1e-9) {
    np += f * (min(len, P.step) / len);
  }
  posOut[i] = clamp(np, vec2f(0.0), vec2f(WORLD));
}
`;

export class GpuLevelSim {
  private readonly device: GPUDevice;
  private readonly n: number;
  private readonly avgDeg: number;
  private readonly params: SimParams;
  private readonly schedule: LevelSchedule;
  private readonly iters: number;
  private iter = 0;
  private flip = false;

  private readonly uniform: GPUBuffer;
  private readonly posA: GPUBuffer;
  private readonly posB: GPUBuffer;
  private readonly fineGrid: GPUBuffer;
  private readonly coarseGrid: GPUBuffer;
  private readonly csr: GPUBuffer[];
  private readonly root: GPUBuffer;
  private readonly staging: GPUBuffer;
  private readonly pipelines: Record<string, GPUComputePipeline>;
  private readonly bindAB: GPUBindGroup;
  private readonly bindBA: GPUBindGroup;

  constructor(
    device: GPUDevice,
    level: LevelGraph,
    positions: Float32Array,
    params: SimParams,
    schedule: LevelSchedule,
    iters: number,
  ) {
    this.device = device;
    this.n = level.n;
    this.avgDeg = level.targets.length / Math.max(1, level.n);
    this.params = params;
    this.schedule = schedule;
    this.iters = iters;

    const storage = (data: Uint32Array | Float32Array, extraUsage = 0) => {
      const buf = device.createBuffer({
        size: Math.max(4, data.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | extraUsage,
      });
      device.queue.writeBuffer(buf, 0, data as Float32Array<ArrayBuffer>);
      return buf;
    };

    this.uniform = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.posA = storage(positions, GPUBufferUsage.COPY_SRC);
    this.posB = storage(positions, GPUBufferUsage.COPY_SRC);
    this.fineGrid = device.createBuffer({
      size: 4 * 3 * GRID * GRID,
      usage: GPUBufferUsage.STORAGE,
    });
    this.coarseGrid = device.createBuffer({
      size: 4 * 3 * GRID2 * GRID2,
      usage: GPUBufferUsage.STORAGE,
    });
    this.csr = [storage(level.offsets), storage(level.targets), storage(level.weights)];
    this.root = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE });
    this.staging = device.createBuffer({
      size: positions.byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const module = device.createShaderModule({ code: SHADER });
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipeline = (entryPoint: string) =>
      device.createComputePipeline({
        layout: pipelineLayout,
        compute: { module, entryPoint },
      });
    this.pipelines = {
      clearGrid: pipeline('clearGrid'),
      aggregate: pipeline('aggregate'),
      reduceRoot: pipeline('reduceRoot'),
      forces: pipeline('forces'),
    };

    const bind = (posIn: GPUBuffer, posOut: GPUBuffer) =>
      device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: { buffer: posIn } },
          { binding: 2, resource: { buffer: posOut } },
          { binding: 3, resource: { buffer: this.fineGrid } },
          { binding: 4, resource: { buffer: this.coarseGrid } },
          { binding: 5, resource: { buffer: this.csr[0] } },
          { binding: 6, resource: { buffer: this.csr[1] } },
          { binding: 7, resource: { buffer: this.csr[2] } },
          { binding: 8, resource: { buffer: this.root } },
        ],
      });
    this.bindAB = bind(this.posA, this.posB);
    this.bindBA = bind(this.posB, this.posA);
  }

  /** Enqueue one iteration (does not await the GPU). */
  step(): void {
    const stepSize = stepAt(this.schedule, this.iter++, this.iters);
    const kOpt = this.schedule.kOpt;
    const u = new Float32Array(8);
    new Uint32Array(u.buffer)[0] = this.n;
    u[1] = stepSize;
    u[2] = this.params.attractionScale * this.avgDeg * kOpt;
    u[3] = this.params.repulsionScale * kOpt * kOpt;
    u[4] = this.params.gravity;
    u[5] = this.params.weightCap;
    this.device.queue.writeBuffer(this.uniform, 0, u);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    const bind = this.flip ? this.bindBA : this.bindAB;
    pass.setBindGroup(0, bind);
    pass.setPipeline(this.pipelines.clearGrid);
    pass.dispatchWorkgroups(Math.ceil((3 * GRID * GRID) / 256));
    pass.setPipeline(this.pipelines.aggregate);
    pass.dispatchWorkgroups(Math.ceil(this.n / 256));
    pass.setPipeline(this.pipelines.reduceRoot);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(this.pipelines.forces);
    pass.dispatchWorkgroups(Math.ceil(this.n / 256));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    this.flip = !this.flip;
  }

  /** Buffer holding the most recently written positions. */
  currentBuffer(): GPUBuffer {
    return this.flip ? this.posB : this.posA;
  }

  /** Copy current positions into another buffer on the same device. */
  copyInto(target: GPUBuffer): void {
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.currentBuffer(), 0, target, 0, 8 * this.n);
    this.device.queue.submit([encoder.finish()]);
  }

  /** Read positions back to the CPU. */
  async read(): Promise<Float32Array> {
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.currentBuffer(), 0, this.staging, 0, 8 * this.n);
    this.device.queue.submit([encoder.finish()]);
    await this.staging.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(this.staging.getMappedRange().slice(0));
    this.staging.unmap();
    return out;
  }

  dispose(): void {
    for (const b of [
      this.uniform,
      this.posA,
      this.posB,
      this.fineGrid,
      this.coarseGrid,
      ...this.csr,
      this.root,
      this.staging,
    ]) {
      b.destroy();
    }
  }
}
