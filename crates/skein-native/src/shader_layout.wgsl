// Body ported verbatim from web/src/layout/gpu.ts's SHADER constant (D13/N1).
// The `const` block that precedes this is generated in gpu_layout.rs from
// skein-core's constants, where the TS original interpolates them from
// params.ts — so the two cannot drift silently. Everything below should diff
// clean against the TypeScript.
//
// Cross-node grid aggregation uses integer fixed-point atomics
// (order-independent => deterministic, D2); every float accumulation happens
// sequentially inside one node's thread.

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

// Single sequential thread: fixed order => deterministic float sums.
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
