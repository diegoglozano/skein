// M0 spike: load a fixture graph into cosmos.gl, measure load time, simulation
// convergence, and frame rate at rest and under scripted pan/zoom. Metrics are
// exposed on window.__spike for the Playwright runner (tests/spike.spec.ts).
//
// Pass criteria live in docs/DECISIONS.md D3. Numbers from headless CI
// (SwiftShader) are functional-validation only — the verdict needs real GPUs.

import { Graph } from '@cosmos.gl/graph';

interface SpikeMetrics {
  fixture: string;
  seed: number;
  nodes: number;
  edges: number;
  renderer: string;
  phase: string;
  fetchMs?: number;
  setDataMs?: number;
  firstTickMs?: number;
  simTicks: number;
  simEndMs?: number;
  settledAlpha?: number;
  fpsDuringSim: number[];
  fpsPanZoom: number[];
  error?: string;
  done: boolean;
}

const params = new URLSearchParams(location.search);
const fixture = params.get('fixture') ?? 'tiny';
const seed = Number(params.get('seed') ?? 42);
const simCapMs = Number(params.get('simCapMs') ?? 120_000);
const panZoomMs = Number(params.get('panZoomMs') ?? 10_000);

const metrics: SpikeMetrics = {
  fixture,
  seed,
  nodes: 0,
  edges: 0,
  renderer: 'unknown',
  phase: 'boot',
  simTicks: 0,
  fpsDuringSim: [],
  fpsPanZoom: [],
  done: false,
};
(window as unknown as { __spike: SpikeMetrics }).__spike = metrics;

const hud = document.getElementById('hud')!;
function setPhase(phase: string) {
  metrics.phase = phase;
  hud.textContent = `${fixture}  n=${metrics.nodes}  m=${metrics.edges}\nphase: ${phase}\nticks: ${metrics.simTicks}`;
}

// Deterministic initial positions (§6): mulberry32.
function seededPositions(n: number, spaceSize: number, s: number): Float32Array {
  let a = s >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const xy = new Float32Array(2 * n);
  for (let i = 0; i < 2 * n; i++) xy[i] = rand() * spaceSize;
  return xy;
}

// One fps sample per second while `active()` holds; samples land in `out`.
function sampleFps(out: number[], active: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    let frames = 0;
    let windowStart = performance.now();
    const loop = () => {
      if (!active()) return resolve();
      frames++;
      const now = performance.now();
      if (now - windowStart >= 1000) {
        out.push(Math.round((frames * 10000) / (now - windowStart)) / 10);
        frames = 0;
        windowStart = now;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}

function rendererInfo(): string {
  try {
    const gl =
      document.createElement('canvas').getContext('webgl2') ??
      document.createElement('canvas').getContext('webgl');
    if (!gl) return 'no-webgl';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'webgl (masked)';
  } catch {
    return 'unknown';
  }
}

async function run() {
  metrics.renderer = rendererInfo();

  setPhase('fetch');
  let t = performance.now();
  const res = await fetch(`/fixtures/${fixture}.bin`);
  if (!res.ok) throw new Error(`fixture fetch failed: ${res.status} ${await res.text()}`);
  const buf = await res.arrayBuffer();
  metrics.fetchMs = Math.round(performance.now() - t);

  const header = new Uint32Array(buf, 0, 4);
  if (header[0] !== 0x534b4e31) throw new Error('bad fixture magic');
  const n = header[1];
  const m = header[2];
  metrics.nodes = n;
  metrics.edges = m;
  const pairs = new Uint32Array(buf, 16, 2 * m);

  setPhase('setData');
  t = performance.now();
  const spaceSize = 8192;
  const positions = seededPositions(n, spaceSize, seed);
  // cosmos takes link endpoints as a Float32Array of index pairs; f32 is exact
  // up to 2^24, far beyond the 1M-node tier.
  const links = new Float32Array(pairs);

  let simEnded = false;
  const simStart = { t: 0 };
  const graph = new Graph(document.getElementById('graph') as HTMLDivElement, {
    spaceSize,
    backgroundColor: '#0b0b12',
    pointSizeScale: 0.4,
    linkWidthScale: 0.2,
    enableSimulation: true,
    randomSeed: seed,
    simulationDecay: 5000,
    onSimulationTick: () => {
      metrics.simTicks++;
      if (metrics.firstTickMs === undefined) {
        metrics.firstTickMs = Math.round(performance.now() - simStart.t);
      }
      if (metrics.simTicks % 20 === 0) setPhase('simulate');
    },
    onSimulationEnd: () => {
      simEnded = true;
    },
  });
  await graph.ready;
  graph.setPointPositions(positions);
  graph.setLinks(links);
  graph.render();
  metrics.setDataMs = Math.round(performance.now() - t);

  setPhase('simulate');
  simStart.t = performance.now();
  graph.start(1);
  const simDeadline = simStart.t + simCapMs;
  await sampleFps(metrics.fpsDuringSim, () => !simEnded && performance.now() < simDeadline);
  metrics.simEndMs = Math.round(performance.now() - simStart.t);
  if (!simEnded) graph.pause();

  setPhase('panzoom');
  graph.fitView(400);
  const pzEnd = performance.now() + panZoomMs;
  // Scripted camera work: zoom oscillation + per-node fly-tos, roughly what a
  // user exploring does. Runs concurrently with fps sampling.
  const script = (async () => {
    let i = 0;
    while (performance.now() < pzEnd) {
      graph.setZoomLevel(i % 2 === 0 ? 4 : 0.5, 900);
      await new Promise((r) => setTimeout(r, 1000));
      graph.zoomToPointByIndex((i * 97911) % n, 900);
      await new Promise((r) => setTimeout(r, 1000));
      i++;
    }
    graph.fitView(300);
  })();
  await Promise.all([sampleFps(metrics.fpsPanZoom, () => performance.now() < pzEnd), script]);

  setPhase('done');
  metrics.done = true;
}

run().catch((err) => {
  metrics.error = String(err?.stack ?? err);
  metrics.phase = 'error';
  metrics.done = true;
  hud.textContent = `ERROR\n${metrics.error}`;
});
