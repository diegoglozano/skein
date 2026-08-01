// Graph view: renders a loaded graph with pan/zoom, owns the M3 layout flow —
// load persisted positions for the current seed, or compute them and persist
// per seed — and the M4 explore surface: hover, selection, 1-hop
// neighbourhood, and id search. Two layout engines, same algorithm: with
// WebGPU the WGSL compute sim runs here on the main thread (the device is
// main-thread-owned), so the hierarchy is fetched from the worker; without it
// the whole multilevel layout runs in WASM inside the worker and we just
// render its progress. The seed is user-visible policy (§6): same file + seed
// ⇒ same picture.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  createRenderer,
  lodLimits,
  screenCoverage,
  shuffleEdgePairs,
  shuffledOrder,
  type DrawLimits,
  type RenderGraph,
  type Renderer,
  type ViewTransform,
} from '../render';
import { multilevelLayout } from '../layout/multilevel';
import { WORLD_SIZE, mulberry32, type LayoutProgress } from '../layout/params';
import { buildPickIndex, pickNode, visibleNodeCount, type PickIndex } from '../interact/pick';
import { nodeId, searchNodes, type SearchHit } from '../interact/search';
import type {
  FromWorker,
  HierarchyLevelBuffers,
  LoadedGraph,
  ToWorker,
} from '../workers/protocol';

export const DEFAULT_SEED = 42;

/** Cursor slack for hit-testing, in CSS pixels. */
const PICK_RADIUS_PX = 12;
/** Pointer travel below this (CSS px) between down and up counts as a click. */
const CLICK_SLOP_PX = 4;
/** Neighbours listed in the sidebar; the highlight still covers all of them. */
const NEIGHBOR_LIST_LIMIT = 100;

function seededScatter(n: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const xy = new Float32Array(2 * n);
  for (let i = 0; i < 2 * n; i++) xy[i] = rand() * WORLD_SIZE;
  return xy;
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
  /** D5 instrumentation for the explore path: cost of the last hit-test, id
   * search scan, and worker neighbourhood round trip, in ms. Measured here
   * rather than from the driving script, whose input round trip is quantised
   * to the frame period and would report ~33 ms for a 0.1 ms pick. */
  pickMs: number | null;
  searchMs: number | null;
  neighborsMs: number | null;
  /** Zoom-adaptive draw budget (D13), as of the last frame. */
  drawnNodes: number;
  drawnEdges: number;
  /** Share of the graph inside the viewport; 1 until the pick index exists. */
  visibleFraction: number;
  /**
   * Share of the viewport the graph's on-screen box covers; 1 at and above the
   * fit view, falling as you zoom out past it. Distinct from `visibleFraction`,
   * which saturates exactly where this starts moving.
   */
  coverage: number;
}

declare global {
  interface Window {
    /** Test/bench hook: live render + layout stats. */
    __skeinRender?: RenderStats;
  }
}

/**
 * Await one worker reply of the given type (matching graph id). Rejects if the
 * worker reports `request` failing instead — otherwise a throw in the worker
 * leaves this promise pending forever, and everything awaiting it (including
 * the view's own teardown) hangs with it.
 */
function awaitReply<T extends FromWorker['type']>(
  worker: Worker,
  type: T,
  id: string,
  request: ToWorker['type'],
): Promise<Extract<FromWorker, { type: T }>> {
  return new Promise((resolve, reject) => {
    const listener = (event: MessageEvent<FromWorker>) => {
      const msg = event.data;
      const done = (finish: () => void) => {
        worker.removeEventListener('message', listener);
        finish();
      };
      if (msg.type === type && ('id' in msg ? msg.id === id : true)) {
        done(() => resolve(msg as Extract<FromWorker, { type: T }>));
      } else if (msg.type === 'error' && msg.request === request) {
        done(() => reject(new Error(msg.message)));
      }
    };
    worker.addEventListener('message', listener);
  });
}

/** A node as the sidebar shows it. */
interface NodeRef {
  node: number;
  id: string;
  degree: number;
}

interface Neighborhood {
  node: number;
  total: number;
  listed: NodeRef[];
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
  /** Last sampled draw budget (D13); null until the first fps tick. */
  const [drawn, setDrawn] = useState<{ nodes: number; edges: number } | null>(null);
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [seedInput, setSeedInput] = useState(String(DEFAULT_SEED));
  const [layoutState, setLayoutState] = useState('starting…');
  const [error, setError] = useState<string | null>(null);

  const [hover, setHover] = useState<NodeRef | null>(null);
  const [selected, setSelected] = useState<NodeRef | null>(null);
  const [neighborhood, setNeighborhood] = useState<Neighborhood | null>(null);
  const [query, setQuery] = useState('');

  /** Imperative handle into the render effect, for sidebar-driven selection. */
  const viewApi = useRef<{ select: (node: number) => void; focus: (node: number) => void } | null>(
    null,
  );

  const describe = useCallback(
    (node: number): NodeRef => ({
      node,
      id: nodeId(graph.idBytes, graph.idOffsets, node),
      degree: graph.degrees[node],
    }),
    [graph],
  );

  const search = useMemo(() => {
    if (!query) return null;
    const t0 = performance.now();
    const result = searchNodes(graph.idBytes, graph.idOffsets, query);
    // Records the scan itself, separately from the keystroke→repaint latency
    // the driving script sees (D5 instrumentation).
    if (window.__skeinRender) window.__skeinRender.searchMs = performance.now() - t0;
    return result;
  }, [graph, query]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const camera = new Camera();
    setDrawn(null);
    let disposed = false;
    let raf = 0;
    let renderer: Renderer | null = null;
    /** Set while a worker-side layout is in flight; see workerLayout below. */
    let detachLayoutListener: (() => void) | null = null;
    /** Teardown steps, registered as each resource is acquired. `run` can
     * return early at several awaits (unmounted mid-layout), so cleanup must
     * not depend on reaching its end — the `message` listener below is on the
     * long-lived worker and would otherwise outlive every closed view. */
    const teardown: (() => void)[] = [];

    const stats: RenderStats = {
      backend: 'starting…',
      fps: 0,
      nodes: graph.nodeCount,
      edges: graph.edgeCount,
      frames: 0,
      layoutState: 'starting…',
      layoutMs: null,
      positionsHash: null,
      pickMs: null,
      searchMs: null,
      neighborsMs: null,
      drawnNodes: graph.nodeCount,
      drawnEdges: graph.edgeCount,
      visibleFraction: 1,
      coverage: 1,
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
      teardown.push(() => renderer!.dispose());
      setBackend(renderer.backend);
      stats.backend = renderer.backend;

      // Both buffers are permuted so that any prefix of them is an unbiased
      // sample — that is what lets the frame loop below cap them by zoom.
      shuffleEdgePairs(graph.endpoints, seed);
      const renderGraph: RenderGraph = {
        nodeCount: graph.nodeCount,
        edgeCount: graph.edgeCount,
        positions: seededScatter(graph.nodeCount, seed),
        endpoints: graph.endpoints,
        nodeOrder: shuffledOrder(graph.nodeCount, seed),
      };
      renderer.setGraph(renderGraph);

      const dpr = window.devicePixelRatio || 1;
      const resize = () => {
        const w = Math.round(canvas.clientWidth * dpr);
        const h = Math.round(canvas.clientHeight * dpr);
        if (!w || !h) return;
        // Only the GPU surface is conditional. The camera is rebuilt with this
        // effect while the <canvas> element is not, so on a re-run (seed
        // change) the backing store already matches and the guard skips —
        // leaving a fresh Camera on its 1x1 default, which silently breaks
        // both the projection and every screen→world pick.
        if (canvas.width !== w || canvas.height !== h) renderer!.resize(w, h);
        camera.setViewport(w, h);
      };
      resize();
      camera.fit(0, 0, WORLD_SIZE, WORLD_SIZE);
      const observer = new ResizeObserver(resize);
      observer.observe(canvas);
      teardown.push(() => observer.disconnect());

      // ---- Explore state. Picking only becomes available once positions are
      // final: the index is two O(n) passes, too much to redo per preview tick.
      let pickIndex: PickIndex | null = null;
      let livePositions: Float32Array | null = null;
      /**
       * World-space span of the settled layout plus the zoom the fit view
       * landed on, kept for the draw budget's `coverage` term (D13). The fit
       * zoom is the reference point: the budget is a measurement taken there,
       * so coverage is 1 there and D8's cap comes out unscaled. Null until the
       * layout finishes, which is the same point the pick index appears —
       * before that the budget falls back to those fixed caps.
       */
      let layoutSpan: { x: number; y: number; fitZoom: number } | null = null;
      let hoverNode = -1;
      let selectedNode = -1;

      // Overlay buffers. Hover changes at pointer rate while the selection
      // does not, so the selection is written once per click into a buffer
      // laid out as [selected, ...neighbours, hover] and hover only rewrites
      // the trailing slot. Rebuilding both per pointermove meant allocating
      // and re-uploading ~240 KB for a one-index delta at the neighbour cap.
      let overlayNodes = new Uint32Array(1);
      /** Nodes in `overlayNodes` before the hover slot. */
      let overlayFixed = 0;
      let overlayEdges = new Uint32Array(0);
      let neighborsAskedAt = 0;

      const uploadOverlay = () => {
        if (!renderer) return;
        const hovered = hoverNode >= 0 && hoverNode !== selectedNode;
        if (hovered) overlayNodes[overlayFixed] = hoverNode;
        renderer.setHighlight(overlayNodes.subarray(0, overlayFixed + (hovered ? 1 : 0)), overlayEdges);
      };

      /** Rebuild the selection part of the overlay (click rate, not hover). */
      const setSelectionOverlay = (neighbors: Uint32Array) => {
        const k = neighbors.length;
        const base = selectedNode >= 0 ? 1 : 0;
        // +1 for the hover slot at the tail.
        if (overlayNodes.length < base + k + 1) overlayNodes = new Uint32Array(base + k + 1);
        if (base) overlayNodes[0] = selectedNode;
        overlayNodes.set(neighbors, base);
        overlayFixed = base + k;

        overlayEdges = new Uint32Array(2 * k);
        for (let i = 0; i < k; i++) {
          overlayEdges[2 * i] = selectedNode;
          overlayEdges[2 * i + 1] = neighbors[i];
        }
        uploadOverlay();
      };

      const select = (node: number) => {
        selectedNode = node;
        setSelectionOverlay(new Uint32Array(0));
        setSelected(node >= 0 ? describe(node) : null);
        setNeighborhood(null);
        if (node >= 0) {
          neighborsAskedAt = performance.now();
          worker.postMessage({ type: 'neighbors', id: graph.id, node } satisfies ToWorker);
        }
      };

      const onNeighbors = (event: MessageEvent<FromWorker>) => {
        const msg = event.data;
        if (msg.type !== 'neighbors' || msg.id !== graph.id) return;
        if (msg.node !== selectedNode) return; // a stale reply for a previous click
        stats.neighborsMs = performance.now() - neighborsAskedAt;
        setSelectionOverlay(msg.neighbors);
        // Decode ids once, here — doing it in the JSX re-ran TextDecoder for
        // every listed neighbour on every hover-driven re-render.
        const listed: NodeRef[] = [];
        for (let i = 0; i < Math.min(msg.neighbors.length, NEIGHBOR_LIST_LIMIT); i++) {
          listed.push(describe(msg.neighbors[i]));
        }
        setNeighborhood({ node: msg.node, total: msg.total, listed });
      };
      worker.addEventListener('message', onNeighbors);
      teardown.push(() => worker.removeEventListener('message', onNeighbors));

      const focus = (node: number) => {
        if (!livePositions) return;
        const x = livePositions[2 * node];
        const y = livePositions[2 * node + 1];
        // Keep the current zoom; just centre the node.
        camera.centerX = x;
        camera.centerY = y;
      };
      viewApi.current = { select, focus };

      // ---- Pointer: pan/zoom plus pick-on-move and select-on-click.
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      let downX = 0;
      let downY = 0;
      let travel = 0;

      const pickAt = (clientX: number, clientY: number): number => {
        if (!pickIndex || !livePositions) return -1;
        const rect = canvas.getBoundingClientRect();
        const { x, y } = camera.worldAt((clientX - rect.left) * dpr, (clientY - rect.top) * dpr);
        const t0 = performance.now();
        const node = pickNode(
          pickIndex,
          livePositions,
          x,
          y,
          PICK_RADIUS_PX * dpr * camera.worldPerPixel(),
        );
        stats.pickMs = performance.now() - t0;
        return node;
      };

      const onPointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return; // right/middle click must not select
        dragging = true;
        travel = 0;
        lastX = downX = e.clientX;
        lastY = downY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
      };
      const onPointerMove = (e: PointerEvent) => {
        if (dragging) {
          camera.panBy((e.clientX - lastX) * dpr, (e.clientY - lastY) * dpr);
          lastX = e.clientX;
          lastY = e.clientY;
          travel = Math.max(travel, Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY));
          return;
        }
        const node = pickAt(e.clientX, e.clientY);
        if (node === hoverNode) return;
        hoverNode = node;
        uploadOverlay();
        setHover(node >= 0 ? describe(node) : null);
        canvas.style.cursor = node >= 0 ? 'pointer' : 'default';
      };
      const onPointerUp = (e: PointerEvent) => {
        // Only a gesture that began on the canvas selects: releasing here
        // after a press that started in the sidebar is not a click on a node.
        if (!dragging) return;
        dragging = false;
        if (travel > CLICK_SLOP_PX) return;
        select(pickAt(e.clientX, e.clientY));
      };
      // Without this, a UA-cancelled gesture leaves `dragging` latched: the
      // camera then pans with no button held and, worse, pointermove never
      // reaches the pick branch again — hover and selection die for good.
      const onPointerCancel = () => {
        dragging = false;
      };
      const onPointerLeave = () => {
        if (hoverNode < 0) return;
        hoverNode = -1;
        uploadOverlay();
        setHover(null);
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
      canvas.addEventListener('pointercancel', onPointerCancel);
      canvas.addEventListener('pointerleave', onPointerLeave);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      teardown.push(() => {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerCancel);
        canvas.removeEventListener('pointerleave', onPointerLeave);
        canvas.removeEventListener('wheel', onWheel);
      });

      /**
       * How much of the graph to submit this frame (D13). A pure function of
       * the camera and the pick grid — deliberately not of the measured fps,
       * which would make the picture depend on machine load and break §6's
       * "same file + seed + machine + browser ⇒ same picture".
       *
       * Before the layout settles there is no pick index, so this reports the
       * whole graph as visible and the limits collapse to D8's fixed caps.
       */
      const drawLimits = (view: ViewTransform): DrawLimits => {
        let fraction = 1;
        if (pickIndex) {
          const a = camera.worldAt(0, 0);
          const b = camera.worldAt(view.widthPx, view.heightPx);
          const visible = visibleNodeCount(
            pickIndex,
            Math.min(a.x, b.x),
            Math.min(a.y, b.y),
            Math.max(a.x, b.x),
            Math.max(a.y, b.y),
          );
          fraction = visible / graph.nodeCount;
        }
        stats.visibleFraction = fraction;
        // `fraction` saturates at 1 as soon as the graph fits on screen, so on
        // its own it cannot see the zoom-out direction — where fixed-pixel node
        // quads pile onto a shrinking patch of screen and blended overdraw is
        // what costs (D13).
        const coverage = layoutSpan
          ? screenCoverage(
              layoutSpan.x,
              layoutSpan.y,
              camera.zoom,
              layoutSpan.fitZoom,
              view.widthPx,
              view.heightPx,
            )
          : 1;
        stats.coverage = coverage;
        const limits = lodLimits(graph.nodeCount, graph.edgeCount, fraction, coverage);
        stats.drawnNodes = limits.nodeLimit;
        stats.drawnEdges = limits.edgeLimit;
        return limits;
      };

      let windowStart = performance.now();
      let windowFrames = 0;
      const frame = () => {
        if (disposed) return;
        const view = camera.view(2.5 * dpr);
        renderer!.render(view, drawLimits(view));
        stats.frames++;
        windowFrames++;
        const now = performance.now();
        if (now - windowStart >= 1000) {
          stats.fps = Math.round((windowFrames * 10000) / (now - windowStart)) / 10;
          setFps(stats.fps);
          // The drawn counts move every frame; publishing them to React at
          // that rate would re-render the whole panel on each one. The HUD
          // rides the existing once-a-second fps tick instead.
          setDrawn({ nodes: stats.drawnNodes, edges: stats.drawnEdges });
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
        const hierarchyReply = awaitReply(worker, 'hierarchy', graph.id, 'hierarchy');
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
            } else if (msg.type === 'error' && msg.request === 'layout') {
              // Only our own request aborts the layout — a failed hover or
              // selection query shares this channel and must not kill the view.
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
        if (minX < maxX && minY < maxY) {
          camera.fit(minX, minY, maxX, maxY, 1.15);
          layoutSpan = { x: maxX - minX, y: maxY - minY, fitZoom: camera.zoom };
        }
        // Explore is live from here: hit-testing needs settled coordinates.
        livePositions = positions;
        pickIndex = buildPickIndex(positions);
        setLayout(state);
      };

      const saved = awaitReply(worker, 'positions', graph.id, 'load-positions');
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

    };

    run().catch((err) => {
      if (!disposed) setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      viewApi.current = null;
      // A worker-side layout would otherwise keep the worker busy and delay
      // the next one (seed change, or a different graph).
      worker.postMessage({ type: 'cancel-layout' } satisfies ToWorker);
      detachLayoutListener?.();
      delete window.__skeinRender;
      // Synchronous, not chained onto `run`: if a worker request never gets a
      // reply, `run` stays pending forever and a deferred teardown would leak
      // the GPU device, the observer and the worker listener with it. Every
      // await in `run` re-checks `disposed` before touching the renderer.
      for (const fn of teardown.splice(0)) fn();
    };
  }, [graph, seed, worker, describe]);

  // A re-layout invalidates every coordinate, so the old selection means
  // nothing visually; clear the explore panel with it.
  useEffect(() => {
    setHover(null);
    setSelected(null);
    setNeighborhood(null);
  }, [seed]);

  const pick = useCallback((node: number) => {
    viewApi.current?.select(node);
    if (node >= 0) viewApi.current?.focus(node);
  }, []);

  return (
    <div className="graph-view" data-testid="graph-view">
      <div className="graph-hud">
        <span>
          <strong>{name}</strong> — {graph.nodeCount.toLocaleString()} nodes,{' '}
          {graph.edgeCount.toLocaleString()} edges
          {drawn && (drawn.edges < graph.edgeCount || drawn.nodes < graph.nodeCount) && (
            <span data-testid="draw-sample">
              {' '}
              (drawing a seeded sample: {drawn.edges.toLocaleString()} edges,{' '}
              {drawn.nodes.toLocaleString()} nodes — zoom in for more)
            </span>
          )}
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
        <div className="graph-body">
          <canvas ref={canvasRef} aria-label="graph canvas" />

          <aside className="explore" aria-label="explore panel">
            <label className="search">
              <span className="muted">find a node</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="node id"
                aria-label="search node id"
                data-testid="node-search"
              />
            </label>

            {search && (
              <div className="results" data-testid="search-results">
                {search.hits.length === 0 ? (
                  <p className="muted">no match</p>
                ) : (
                  <>
                    <ul>
                      {search.hits.map((hit: SearchHit) => (
                        <li key={hit.node}>
                          <button onClick={() => pick(hit.node)} data-testid="search-hit">
                            {hit.id}
                          </button>
                          <em className="muted">{graph.degrees[hit.node]}</em>
                        </li>
                      ))}
                    </ul>
                    {search.truncated && <p className="muted">showing the first matches</p>}
                  </>
                )}
              </div>
            )}

            {hover && !selected && (
              <div className="node-card" data-testid="hover-card">
                <h3>{hover.id}</h3>
                <p className="muted">degree {hover.degree.toLocaleString()}</p>
              </div>
            )}

            {selected && (
              <div className="node-card selected" data-testid="selection-card">
                <h3>{selected.id}</h3>
                <p className="muted">
                  degree {selected.degree.toLocaleString()}
                  {neighborhood
                    ? ` · ${neighborhood.total.toLocaleString()} neighbours`
                    : ' · finding neighbours…'}
                </p>
                {neighborhood && neighborhood.listed.length > 0 && (
                  <ul className="neighbors" data-testid="neighbor-list">
                    {neighborhood.listed.map((n) => (
                      <li key={n.node}>
                        <button onClick={() => pick(n.node)}>{n.id}</button>
                        <em className="muted">{n.degree}</em>
                      </li>
                    ))}
                  </ul>
                )}
                {neighborhood && neighborhood.total > neighborhood.listed.length && (
                  <p className="muted">
                    listing {neighborhood.listed.length} of{' '}
                    {neighborhood.total.toLocaleString()}
                  </p>
                )}
                <button onClick={() => pick(-1)}>clear selection</button>
              </div>
            )}

            {!selected && !hover && !search && (
              <p className="muted hint">
                Hover a node for its id and degree, click to select it and highlight its
                neighbours. Picking wakes up once the layout settles.
              </p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
