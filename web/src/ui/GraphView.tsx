// M2 graph view: renders a loaded graph with pan/zoom. Positions are a
// deterministic seeded scatter until M3's layout lands (seed shown in the
// HUD — §6 determinism is user-visible policy, not an accident).

import { useEffect, useRef, useState } from 'react';
import { Camera, createRenderer, type RenderGraph } from '../render';
import type { LoadedGraph } from '../workers/protocol';

const WORLD_SIZE = 4096;
export const POSITION_SEED = 42;

// Fill-rate budget: with blending, drawn edges cost fragments proportional to
// their on-screen length, and the zoomed-out fit view pays for every drawn
// edge at once. Pre-layout (random) positions are the worst case — the D8
// measurements on the M3 reference laptop: 10M edges ≈ 2 fps, 2M ≈ 6 fps at
// fit, 500k ≈ 24 fps, 300k ≥ 30 fps with margin. The sample is unbiased and
// reproducible because the endpoint pairs are pre-shuffled with a seeded
// permutation. Revisit at M3: a real layout makes edges short, which changes
// the fill economics entirely.
const EDGE_DRAW_CAP = 300_000;

/** mulberry32 — same generator the spike used; deterministic per seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededPositions(n: number, seed: number): Float32Array {
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

interface RenderStats {
  backend: string;
  fps: number;
  nodes: number;
  edges: number;
  frames: number;
}

declare global {
  interface Window {
    /** Test/bench hook: live render stats, updated once a second. */
    __skeinRender?: RenderStats;
  }
}

export function GraphView({ graph, name, onClose }: {
  graph: LoadedGraph;
  name: string;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [backend, setBackend] = useState<string>('starting…');
  const [fps, setFps] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const camera = new Camera();
    let disposed = false;
    let raf = 0;

    const run = async () => {
      const renderer = await createRenderer(canvas);
      if (disposed) {
        renderer.dispose();
        return;
      }
      setBackend(renderer.backend);

      shuffleEdgePairs(graph.endpoints, POSITION_SEED);
      const renderGraph: RenderGraph = {
        nodeCount: graph.nodeCount,
        edgeCount: graph.edgeCount,
        positions: seededPositions(graph.nodeCount, POSITION_SEED),
        endpoints: graph.endpoints,
      };
      renderer.setGraph(renderGraph);

      const dpr = window.devicePixelRatio || 1;
      const resize = () => {
        const w = Math.round(canvas.clientWidth * dpr);
        const h = Math.round(canvas.clientHeight * dpr);
        if (w && h && (canvas.width !== w || canvas.height !== h)) {
          renderer.resize(w, h);
          camera.setViewport(w, h);
        }
      };
      resize();
      camera.fit(0, 0, WORLD_SIZE, WORLD_SIZE);
      const observer = new ResizeObserver(resize);
      observer.observe(canvas);

      // Input: drag to pan, wheel to zoom at cursor.
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

      const stats: RenderStats = {
        backend: renderer.backend,
        fps: 0,
        nodes: graph.nodeCount,
        edges: graph.edgeCount,
        frames: 0,
      };
      window.__skeinRender = stats;
      let windowStart = performance.now();
      let windowFrames = 0;

      const frame = () => {
        if (disposed) return;
        renderer.render(camera.view(2.5 * dpr), EDGE_DRAW_CAP);
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

      return () => {
        observer.disconnect();
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('wheel', onWheel);
        renderer.dispose();
      };
    };

    const cleanup = run().catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      delete window.__skeinRender;
      cleanup.then((fn) => fn?.());
    };
  }, [graph]);

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
        <span>seed: {POSITION_SEED} (layout lands in M3)</span>
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
