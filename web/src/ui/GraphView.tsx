// Graph view: renders a loaded graph with pan/zoom, and owns the M3 layout
// flow — load persisted positions for the current seed, or compute them and
// persist per seed. Two engines, same algorithm: with WebGPU the WGSL compute
// sim runs here on the main thread (the device is main-thread-owned), so the
// hierarchy is fetched from the worker; without it the whole multilevel layout
// runs in WASM inside the worker and we just render its progress. The seed is
// user-visible policy (§6): same file + seed ⇒ same picture.

import { useEffect, useRef, useState } from 'react';
import { Camera, createRenderer, type RenderGraph, type Renderer } from '../render';
import { multilevelLayout } from '../layout/multilevel';
import { WORLD_SIZE, mulberry32, type LayoutProgress } from '../layout/params';
import type {
  FromWorker,
  HierarchyLevelBuffers,
  LoadedGraph,
  ToWorker,
} from '../workers/protocol';

export const DEFAULT_SEED = 42;

// Fill-rate budget (DECISIONS.md D8): pre-layout random positions made 10M
// full-length edges cost billions of blended fragments; post-layout edges are
// short, but the cap stays until re-measured. Sample is a seeded permutation.
const EDGE_DRAW_CAP = 300_000;

function seededScatter(n: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const xy = new Float32Array(2 * n);
  for (let i = 0; i < 2 * n; i++) xy[i] = rand() * WORLD_SIZE;
  return xy;
}

/** In-place seeded Fisher–Yates over endpoint pairs; one flat pass. */
function shuffleEdgePairs(endpoints: Uint32Array, seed: number): void {
  const rand = mulberry32(seed);
  const m = endpoints.length >> 1;
  for (let i = m - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const si = endpoints[2 * i];
    const ti = endpoints[2 * i + 1];
    endpoints[2 * i] = endpoints[2 * j];
    endpoints[2 * i + 1] = endpoints[2 * j + 1];
    endpoints[2 * j] = si;
    endpoints[2 * j + 1] = ti;
  }
}

/** FNV-1a over the position bytes — the determinism test hook. */
function hashPositions(positions: Float32Array): string {
  const bytes = new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

interface RenderStats {
  backend: string;
  fps: number;
  nodes: number;
  edges: number;
  frames: number;
  layoutState: string;
  layoutMs: number | null;
  positionsHash: string | null;
}

declare global {
  interface Window {
    /** Test/bench hook: live render + layout stats. */
    __skeinRender?: RenderStats;
  }
}

/** Await one worker reply of the given type (matching graph id). */
function awaitReply<T extends FromWorker['type']>(
  worker: Worker,
  type: T,
  id: string,
): Promise<Extract<FromWorker, { type: T }>> {
  return new Promise((resolve) => {
    const listener = (event: MessageEvent<FromWorker>) => {
      const msg = event.data;
      if (msg.type === type && ('id' in msg ? msg.id === id : true)) {
        worker.removeEventListener('message', listener);
        resolve(msg as Extract<FromWorker, { type: T }>);
      }
    };
    worker.addEventListener('message', listener);
  });
}

export function GraphView({ graph, name, worker, onClose }: {
  graph: LoadedGraph;
  name: string;
  worker: Worker;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [backend, setBackend] = useState<string>('starting…');
  const [fps, setFps] = useState(0);
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [seedInput, setSeedInput] = useState(String(DEFAULT_SEED));
  const [layoutState, setLayoutState] = useState('starting…');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const camera = new Camera();
    let disposed = false;
    let raf = 0;
    let renderer: Renderer | null = null;
    /** Set while a worker-side layout is in flight; see workerLayout below. */
    let detachLayoutListener: (() => void) | null = null;

    const stats: RenderStats = {
      backend: 'starting…',
      fps: 0,
      nodes: graph.nodeCount,
      edges: graph.edgeCount,
      frames: 0,
      layoutState: 'starting…',
      layoutMs: null,
      positionsHash: null,
    };
    window.__skeinRender = stats;
    const setLayout = (s: string) => {
      stats.layoutState = s;
      setLayoutState(s);
    };

    const run = async () => {
      renderer = await createRenderer(canvas);
      if (disposed) {
        renderer.dispose();
        return;
      }
      setBackend(renderer.backend);
      stats.backend = renderer.backend;

      shuffleEdgePairs(graph.endpoints, seed);
      const renderGraph: RenderGraph = {
        nodeCount: graph.nodeCount,
        edgeCount: graph.edgeCount,
        positions: seededScatter(graph.nodeCount, seed),
        endpoints: graph.endpoints,
      };
      renderer.setGraph(renderGraph);

      const dpr = window.devicePixelRatio || 1;
      const resize = () => {
        const w = Math.round(canvas.clientWidth * dpr);
        const h = Math.round(canvas.clientHeight * dpr);
        if (w && h && (canvas.width !== w || canvas.height !== h)) {
          renderer!.resize(w, h);
          camera.setViewport(w, h);
        }
      };
      resize();
      camera.fit(0, 0, WORLD_SIZE, WORLD_SIZE);
      const observer = new ResizeObserver(resize);
      observer.observe(canvas);

      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      const onPointerDown = (e: PointerEvent) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
      };
      const onPointerMove = (e: PointerEvent) => {
        if (!dragging) return;
        camera.panBy((e.clientX - lastX) * dpr, (e.clientY - lastY) * dpr);
        lastX = e.clientX;
        lastY = e.clientY;
      };
      const onPointerUp = () => {
        dragging = false;
      };
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        camera.zoomAt(
          Math.exp(-e.deltaY * 0.002),
          (e.clientX - rect.left) * dpr,
          (e.clientY - rect.top) * dpr,
        );
      };
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('wheel', onWheel, { passive: false });

      let windowStart = performance.now();
      let windowFrames = 0;
      const frame = () => {
        if (disposed) return;
        renderer!.render(camera.view(2.5 * dpr), EDGE_DRAW_CAP);
        stats.frames++;
        windowFrames++;
        const now = performance.now();
        if (now - windowStart >= 1000) {
          stats.fps = Math.round((windowFrames * 10000) / (now - windowStart)) / 10;
          setFps(stats.fps);
          windowFrames = 0;
          windowStart = now;
        }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);

      // ---- Layout flow: load persisted positions for this seed, or compute.
      const onLevelProgress = (p: LayoutProgress) =>
        setLayout(`level ${p.level}/${p.levels} · iter ${p.iter}/${p.iters}`);

      /** WebGPU tier: hierarchy from the worker, WGSL sim on this thread. */
      const gpuLayout = async (device: GPUDevice) => {
        const hierarchyReply = awaitReply(worker, 'hierarchy', graph.id);
        worker.postMessage({ type: 'hierarchy', id: graph.id } satisfies ToWorker);
        const { levels } = await hierarchyReply;
        if (disposed) return null;
        const gpuTarget = renderer!.positionsGpuBuffer?.() ?? null;
        return multilevelLayout(levels as HierarchyLevelBuffers[], {
          seed,
          device,
          onProgress: (p) => {
            if (disposed) return false;
            onLevelProgress(p);
            return true;
          },
          onPositions: (sim, nodeCount) => {
            // Live preview only once the sim reaches the full-resolution level.
            if (nodeCount === graph.nodeCount && gpuTarget) sim.copyInto(gpuTarget);
          },
        });
      };

      /** Fallback tier: the whole multilevel layout runs in WASM, in the
       * worker; we only render the previews it sends. */
      const workerLayout = () =>
        new Promise<Float32Array | null>((resolve, reject) => {
          const stop = () => {
            worker.removeEventListener('message', listener);
            detachLayoutListener = null;
          };
          const listener = (event: MessageEvent<FromWorker>) => {
            const msg = event.data;
            if (msg.type === 'layout-progress' && msg.id === graph.id) {
              onLevelProgress(msg);
              if (msg.positions) renderer!.updatePositions(msg.positions);
            } else if (msg.type === 'layout-done' && msg.id === graph.id) {
              stop();
              resolve(msg.positions);
            } else if (msg.type === 'error') {
              stop();
              reject(new Error(msg.message));
            }
          };
          worker.addEventListener('message', listener);
          // A cancelled layout never replies, so unmount has to unhook us.
          detachLayoutListener = () => {
            stop();
            resolve(null);
          };
          worker.postMessage({ type: 'layout', id: graph.id, seed } satisfies ToWorker);
        });

      const finishWith = (positions: Float32Array, state: string) => {
        renderer!.updatePositions(positions);
        stats.positionsHash = hashPositions(positions);
        // Frame the actual layout, not the whole world square.
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
        if (minX < maxX && minY < maxY) camera.fit(minX, minY, maxX, maxY, 1.15);
        setLayout(state);
      };

      const saved = awaitReply(worker, 'positions', graph.id);
      worker.postMessage({ type: 'load-positions', id: graph.id, seed } satisfies ToWorker);
      const savedReply = await saved;
      if (disposed) return;
      if (savedReply.positions) {
        finishWith(savedReply.positions, 'loaded from storage');
      } else {
        setLayout('building hierarchy…');
        // The clock includes coarsening — §9's layout budget covers the
        // whole pipeline from CSR to final positions.
        const t0 = performance.now();
        const device = renderer.device;
        const positions = device ? await gpuLayout(device) : await workerLayout();
        if (disposed || !positions) return;
        const ms = Math.round(performance.now() - t0);
        stats.layoutMs = ms;
        finishWith(positions, `ready in ${(ms / 1000).toFixed(1)} s`);
        worker.postMessage(
          { type: 'save-positions', id: graph.id, seed, positions } satisfies ToWorker,
        );
      }

      return () => {
        observer.disconnect();
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('wheel', onWheel);
        renderer!.dispose();
      };
    };

    const cleanup = run().catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      // A worker-side layout would otherwise keep the worker busy and delay
      // the next one (seed change, or a different graph).
      worker.postMessage({ type: 'cancel-layout' } satisfies ToWorker);
      detachLayoutListener?.();
      delete window.__skeinRender;
      cleanup.then((fn) => fn?.());
    };
  }, [graph, seed, worker]);

  return (
    <div className="graph-view" data-testid="graph-view">
      <div className="graph-hud">
        <span>
          <strong>{name}</strong> — {graph.nodeCount.toLocaleString()} nodes,{' '}
          {graph.edgeCount.toLocaleString()} edges
          {graph.edgeCount > EDGE_DRAW_CAP &&
            ` (drawing a seeded ${EDGE_DRAW_CAP.toLocaleString()}-edge sample)`}
        </span>
        <span data-testid="render-backend">renderer: {backend}</span>
        <span data-testid="layout-status">layout: {layoutState}</span>
        <label>
          seed{' '}
          <input
            className="seed-input"
            value={seedInput}
            onChange={(e) => setSeedInput(e.target.value)}
            size={6}
            aria-label="layout seed"
          />
        </label>
        <button
          onClick={() => {
            const s = Number(seedInput);
            if (Number.isFinite(s)) setSeed(s >>> 0);
          }}
        >
          re-layout
        </button>
        <span data-testid="render-fps">{fps} fps</span>
        <button onClick={onClose}>close</button>
      </div>
      {error ? (
        <p className="summary error" role="alert">
          render failed: {error}
        </p>
      ) : (
        <canvas ref={canvasRef} aria-label="graph canvas" />
      )}
    </div>
  );
}
