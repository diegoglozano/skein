// Fast layout-quality harness: runs the CPU sim on the clustered fixture in
// Node (no browser, no GPU) and prints separation metrics. Used to calibrate
// force parameters before confirming on real hardware.
//   npx esbuild web/src/layout/cpu.ts --bundle --format=esm --outfile=/tmp/cpu-sim.mjs
//   node tests/tune-layout.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CpuLevelSim } from '/tmp/cpu-sim.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const buf = readFileSync(path.join(root, 'bench/fixtures/clustered.bin'));
const header = new Uint32Array(buf.buffer, buf.byteOffset, 4);
const n = header[1];
const m = header[2];
const pairs = new Uint32Array(buf.buffer, buf.byteOffset + 16, 2 * m);

// Symmetrized weighted adjacency (mirror + dedupe), same shape the wasm
// hierarchy level 0 would produce.
const adj = new Map();
for (let e = 0; e < m; e++) {
  const a = pairs[2 * e];
  const b = pairs[2 * e + 1];
  if (a === b) continue;
  for (const [u, v] of [[a, b], [b, a]]) {
    const key = u * 4294967296 + v;
    adj.set(key, (adj.get(key) ?? 0) + 1);
  }
}
const keys = [...adj.keys()].sort((x, y) => x - y);
const offsets = new Uint32Array(n + 1);
const targets = new Uint32Array(keys.length);
const weights = new Float32Array(keys.length);
for (let i = 0; i < keys.length; i++) {
  const u = Math.floor(keys[i] / 4294967296);
  offsets[u + 1]++;
  targets[i] = keys[i] % 4294967296;
  weights[i] = adj.get(keys[i]);
}
for (let i = 1; i <= n; i++) offsets[i] += offsets[i - 1];
const level = { n, offsets, targets, weights };

const WORLD = 4096;
const COMMUNITIES = 40;
const SIZE = Math.floor(n / COMMUNITIES);

function metrics(pos) {
  const cx = new Float64Array(COMMUNITIES);
  const cy = new Float64Array(COMMUNITIES);
  for (let i = 0; i < n; i++) {
    const c = Math.min(COMMUNITIES - 1, Math.floor(i / SIZE));
    cx[c] += pos[2 * i];
    cy[c] += pos[2 * i + 1];
  }
  for (let c = 0; c < COMMUNITIES; c++) {
    cx[c] /= SIZE;
    cy[c] /= SIZE;
  }
  let intra = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const c = Math.min(COMMUNITIES - 1, Math.floor(i / SIZE));
    intra += Math.hypot(pos[2 * i] - cx[c], pos[2 * i + 1] - cy[c]);
    minX = Math.min(minX, pos[2 * i]);
    maxX = Math.max(maxX, pos[2 * i]);
    minY = Math.min(minY, pos[2 * i + 1]);
    maxY = Math.max(maxY, pos[2 * i + 1]);
  }
  intra /= n;
  let inter = 0;
  let count = 0;
  for (let a = 0; a < COMMUNITIES; a++) {
    for (let b = a + 1; b < COMMUNITIES; b++) {
      inter += Math.hypot(cx[a] - cx[b], cy[a] - cy[b]);
      count++;
    }
  }
  inter /= count;
  return {
    intra: Math.round(intra),
    inter: Math.round(inter),
    separation: Math.round((inter / Math.max(1, intra)) * 100) / 100,
    span: `${Math.round(maxX - minX)}×${Math.round(maxY - minY)}`,
    walls: minX < 1 || minY < 1 || maxX > WORLD - 1 || maxY > WORLD - 1,
  };
}

function seeded(nn, seedVal) {
  let a = seedVal >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const xy = new Float32Array(2 * nn);
  const c = WORLD / 2;
  const r = WORLD / 4;
  for (let i = 0; i < nn; i++) {
    const ang = rand() * 2 * Math.PI;
    const d = Math.sqrt(rand()) * r;
    xy[2 * i] = c + Math.cos(ang) * d;
    xy[2 * i + 1] = c + Math.sin(ang) * d;
  }
  return xy;
}

const variants = (process.argv[2]
  ? [JSON.parse(process.argv[2])]
  : [
      { attractionScale: 1, repulsionScale: 1, gravity: 0.03, weightCap: 8 },
      { attractionScale: 2, repulsionScale: 1, gravity: 0.03, weightCap: 8 },
      { attractionScale: 1, repulsionScale: 2, gravity: 0.03, weightCap: 8 },
      { attractionScale: 0.5, repulsionScale: 1, gravity: 0.03, weightCap: 8 },
    ]);

const kOpt = WORLD / Math.sqrt(n);
for (const params of variants) {
  const schedule = { kOpt, stepStart: WORLD / 8, stepEnd: Math.max(0.3, 0.3 * kOpt) };
  const positions = seeded(n, 42);
  const sim = new CpuLevelSim(level, positions, params, schedule, 300);
  const t0 = performance.now();
  for (let i = 0; i < 300; i++) sim.step();
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(JSON.stringify(params), '→', JSON.stringify(metrics(sim.positions)), `${secs}s`);
}
