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
  applyVisibilityMask,
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
import {
  buildPickIndex,
  nodesInRect,
  pickNode,
  visibleNodeCount,
  type PickIndex,
} from '../interact/pick';
import { nodeId, searchNodes, type SearchHit } from '../interact/search';
import type { AttributeStore } from '../analytics/attributes';
import { AttributesPanel } from './AttributesPanel';
import { download, exportStem, positionsCsv } from './export';
import type {
  FromWorker,
  HierarchyLevelBuffers,
  LoadedGraph,
  ToWorker,
} from '../workers/protocol';

export const DEFAULT_SEED = 42;

/** Cursor slack for hit-testing, in CSS pixels. */
const PICK_RADIUS_PX = 12;
/** The same slack for a fingertip, which has no pixel to be precise about. */
const TOUCH_PICK_RADIUS_PX = 24;
/** Pointer travel below this (CSS px) between down and up counts as a click. */
const CLICK_SLOP_PX = 4;
/** A finger wobbles more than a mouse does while tapping. */
const TOUCH_CLICK_SLOP_PX = 12;
/** Step for the on-screen zoom buttons — one press, one comfortable notch. */
const ZOOM_STEP = 1.6;
/** Neighbours listed in the sidebar; the highlight still covers all of them. */
const NEIGHBOR_LIST_LIMIT = 100;
/**
 * Furthest the neighbourhood walk will go (§10 "expand k hops"). Each hop is
 * another pass over the whole CSR in the worker, and in a scale-free graph the
 * fifth one has usually swallowed the component anyway — past here the user is
 * paying seconds to select everything.
 */
const MAX_HOPS = 5;
/**
 * Nodes a box select will *name*. The mask it isolates against covers the
 * whole rectangle regardless — this only bounds the array the overlay draws
 * and the ids the panel decodes, both of which stop being useful long before
 * a drag across a million-node hairball finishes.
 */
const MAX_BOX_SELECTION = 50_000;
/** A drag shorter than this (CSS px) is a click that missed, not a box. */
const MIN_BOX_PX = 6;

/**
 * Phone-shaped viewport. Above it the explore panel is a docked sidebar; below
 * it the canvas takes the whole body and the panel becomes a bottom sheet, so
 * a 17rem sidebar cannot eat two thirds of a 390 px screen. Mirrored by the
 * `@media (max-width: 48rem)` block in app.css — change both together.
 */
const NARROW_QUERY = '(max-width: 48rem)';

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(mq.matches);
    setNarrow(mq.matches); // a rotation between render and effect
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

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
  /** Device pixels per world unit — the camera's zoom, for gesture tests. */
  zoom: number;
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
  hops: number;
  total: number;
  listed: NodeRef[];
}

/** A rectangle's worth of nodes (§10 box select). */
interface BoxSelection {
  total: number;
  listed: NodeRef[];
}

export function GraphView({ graph, name, worker, attached, onClose }: {
  graph: LoadedGraph;
  name: string;
  worker: Worker;
  /** A node-attributes file attached in a previous session, if any (M4). */
  attached: { fileName: string; joinColumn: string } | null;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** The rubber band, moved imperatively: it tracks the pointer, and routing
   * that through React state would re-render the panel on every move. */
  const bandRef = useRef<HTMLDivElement>(null);
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
  /**
   * How far the neighbourhood walk reaches from the selection (§10). Mirrored
   * into a ref because the pointer handlers live inside the render effect,
   * which is rebuilt only on a seed change — closing over the state would
   * leave a click asking for whatever depth was set when the graph loaded.
   */
  const [hops, setHops] = useState(1);
  const hopsRef = useRef(1);
  /** Hide everything outside the current selection (§10 "isolate subgraph"). */
  const [isolated, setIsolated] = useState(false);
  const [boxSelection, setBoxSelection] = useState<BoxSelection | null>(null);
  /**
   * Whether a one-pointer drag draws a selection box instead of panning. A
   * mode rather than only a modifier because touch has no shift key, and this
   * is the one interaction on the canvas with nothing to fall back to (D18
   * made the same argument for the zoom buttons). Shift still works with a
   * mouse and needs no mode.
   */
  const [boxMode, setBoxMode] = useState(false);
  const boxModeRef = useRef(false);

  const narrow = useNarrow();
  /** Bottom-sheet state; meaningless while the panel is docked (wide screen). */
  const [panelOpen, setPanelOpen] = useState(false);

  /** Imperative handle into the render effect, for sidebar-driven selection. */
  const viewApi = useRef<{
    select: (node: number, hops: number) => void;
    focus: (node: number) => void;
    setStyle: (style: Uint32Array | null) => void;
    zoomBy: (factor: number) => void;
    resetView: () => void;
    /** The frame as a PNG, captured inside the frame that drew it. */
    capture: () => Promise<Blob | null>;
    /** Settled layout coordinates, or null while one is still being computed. */
    positions: () => Float32Array | null;
  } | null>(null);

  // Attribute styling and the attribute card. The style buffer is kept here
  // rather than in the render effect because that effect is rebuilt on every
  // seed change, and a re-layout moves nodes without renumbering them — the
  // colours the user picked must survive it.
  const styleRef = useRef<Uint32Array | null>(null);
  const storeRef = useRef<AttributeStore | null>(null);
  const [storeVersion, setStoreVersion] = useState(0);
  const [attrValues, setAttrValues] = useState<Record<string, string> | null>(null);

  // Two independent things write visibility — the attributes panel's filters
  // and "isolate" — and they arrive from different places at different times,
  // so neither can own the buffer the renderer sees. Both are kept as inputs
  // and the buffer is derived from them on every change, which is also what
  // makes the two compose: isolating inside a filtered graph shows the
  // intersection rather than whichever was applied last.
  const maskRef = useRef<Uint8Array | null>(null);
  const isolatedRef = useRef(false);

  const composeStyle = useCallback((): Uint32Array | null => {
    const mask = isolatedRef.current ? maskRef.current : null;
    if (!mask) return styleRef.current;
    return applyVisibilityMask(styleRef.current, mask, graph.nodeCount);
  }, [graph.nodeCount]);

  const pushStyle = useCallback(() => {
    viewApi.current?.setStyle(composeStyle());
  }, [composeStyle]);

  const applyStyle = useCallback(
    (style: Uint32Array | null) => {
      styleRef.current = style;
      pushStyle();
    },
    [pushStyle],
  );

  const setIsolate = useCallback(
    (on: boolean) => {
      isolatedRef.current = on;
      setIsolated(on);
      pushStyle();
    },
    [pushStyle],
  );

  const handleStore = useCallback((store: AttributeStore | null) => {
    storeRef.current = store;
    setStoreVersion((v) => v + 1);
  }, []);

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
      zoom: 1,
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
      /** The settled layout's bounding box, so "fit" can go back to it. */
      let fitBox: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
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

      /**
       * Rebuild the selection part of the overlay (click rate, not hover).
       * `parents` is each member's BFS-tree parent, so past one hop the
       * overlay draws the edges the walk actually used — a star from the seed
       * would draw lines that are not edges of the graph.
       */
      const setSelectionOverlay = (neighbors: Uint32Array, parents: Uint32Array | null) => {
        const k = neighbors.length;
        const base = selectedNode >= 0 ? 1 : 0;
        // +1 for the hover slot at the tail.
        if (overlayNodes.length < base + k + 1) overlayNodes = new Uint32Array(base + k + 1);
        if (base) overlayNodes[0] = selectedNode;
        overlayNodes.set(neighbors, base);
        overlayFixed = base + k;

        // `parents` null means highlight the nodes and nothing joining them —
        // what a box select wants, since the edges induced by a rectangle are
        // not in hand and joining its members to each other would be a claim
        // about adjacency nobody made.
        overlayEdges = new Uint32Array(parents ? 2 * k : 0);
        for (let i = 0; parents && i < k; i++) {
          overlayEdges[2 * i] = parents[i];
          overlayEdges[2 * i + 1] = neighbors[i];
        }
        uploadOverlay();
      };

      const empty = new Uint32Array(0);
      /** Set while the highlight belongs to a box rather than to a node. */
      let boxActive = false;

      const select = (node: number, hopCount: number) => {
        // Isolating is a property of the current selection, not a mode: it
        // survives changing the depth on the same seed (the same subgraph,
        // drawn wider) and is released by selecting something else. Sticky
        // would mean a click on a neighbour instantly hides almost everything,
        // which reads as the graph disappearing rather than as a setting.
        if (boxActive || node !== selectedNode || node < 0) setIsolate(false);
        boxActive = false;
        selectedNode = node;
        setSelectionOverlay(empty, empty);
        setSelected(node >= 0 ? describe(node) : null);
        setNeighborhood(null);
        setBoxSelection(null);
        // The old mask describes a neighbourhood that no longer exists. Drop
        // it before the reply lands, or an isolated view keeps hiding against
        // the previous selection while the panel already shows the new one.
        maskRef.current = null;
        if (node >= 0) {
          neighborsAskedAt = performance.now();
          worker.postMessage({
            type: 'neighbors',
            id: graph.id,
            node,
            hops: hopCount,
          } satisfies ToWorker);
        }
      };

      const onNeighbors = (event: MessageEvent<FromWorker>) => {
        const msg = event.data;
        if (msg.type !== 'neighbors' || msg.id !== graph.id) return;
        if (msg.node !== selectedNode) return; // a stale reply for a previous click
        stats.neighborsMs = performance.now() - neighborsAskedAt;
        setSelectionOverlay(msg.neighbors, msg.parents);
        maskRef.current = msg.mask;
        pushStyle();
        // Decode ids once, here — doing it in the JSX re-ran TextDecoder for
        // every listed neighbour on every hover-driven re-render.
        const listed: NodeRef[] = [];
        for (let i = 0; i < Math.min(msg.neighbors.length, NEIGHBOR_LIST_LIMIT); i++) {
          listed.push(describe(msg.neighbors[i]));
        }
        setNeighborhood({ node: msg.node, hops: msg.hops, total: msg.total, listed });
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
      /** Zoom about the middle of the canvas — what a button press means. */
      const zoomBy = (factor: number) =>
        camera.zoomAt(factor, canvas.width / 2, canvas.height / 2);
      /** Back to the framing `finishWith` chose, or the world square before it. */
      const resetView = () => {
        if (fitBox) camera.fit(fitBox.minX, fitBox.minY, fitBox.maxX, fitBox.maxY, 1.15);
        else camera.fit(0, 0, WORLD_SIZE, WORLD_SIZE);
      };
      /**
       * PNG export. Neither backend preserves its drawing buffer — that costs
       * a copy on every frame to serve an action taken once — so the capture
       * has to happen in the same task as a `render`, before the compositor
       * takes the buffer back. The frame loop below does it right after
       * submitting; `preserveDrawingBuffer` would be the alternative and it
       * would make every frame pay for this button.
       */
      let captureRequest: ((blob: Blob | null) => void) | null = null;
      const capture = () =>
        new Promise<Blob | null>((resolve) => {
          captureRequest = resolve;
        });

      viewApi.current = {
        select,
        focus,
        setStyle: (style) => renderer?.setNodeStyle(style),
        zoomBy,
        resetView,
        capture,
        positions: () => livePositions,
      };
      // Re-apply whatever the attributes panel had set: this effect re-runs on
      // a seed change with a brand-new renderer, whose style buffer is empty.
      // (An isolate mask never survives to here — a re-layout clears the
      // selection it belonged to — but composing is what makes that true
      // rather than something this line has to know.)
      renderer.setNodeStyle(composeStyle());

      // ---- Pointer: pan/zoom plus pick-on-move and select-on-click.
      //
      // Two-finger pinch is the only way to zoom on a touch screen — there is
      // no wheel — so pointers are tracked as a set rather than one drag:
      // every live contact is in `pointers`, and the gesture is whatever its
      // size says it is. Touch also has no hover, so a tap has to do the work
      // a mouse splits between moving and clicking, with a fingertip's slack
      // in both the hit radius and the click threshold.
      const pointers = new Map<number, { x: number; y: number }>();
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      let downX = 0;
      let downY = 0;
      let travel = 0;
      /** Live pinch state, in CSS pixels: finger separation and midpoint. */
      let pinchDist = 0;
      let pinchX = 0;
      let pinchY = 0;

      const pickAt = (clientX: number, clientY: number, radiusPx: number): number => {
        if (!pickIndex || !livePositions) return -1;
        const rect = canvas.getBoundingClientRect();
        const { x, y } = camera.worldAt((clientX - rect.left) * dpr, (clientY - rect.top) * dpr);
        const t0 = performance.now();
        const node = pickNode(
          pickIndex,
          livePositions,
          x,
          y,
          radiusPx * dpr * camera.worldPerPixel(),
        );
        stats.pickMs = performance.now() - t0;
        return node;
      };
      const touchy = (e: PointerEvent) => e.pointerType !== 'mouse';
      const pickRadius = (e: PointerEvent) => (touchy(e) ? TOUCH_PICK_RADIUS_PX : PICK_RADIUS_PX);

      // ---- Box select. The band is a plain absolutely-positioned div over the
      // canvas rather than a renderer pass: it is one rectangle at pointer
      // rate, and putting it in the render path would mean a buffer upload and
      // a pipeline for something the compositor already draws for free.
      let boxing = false;
      let boxX0 = 0;
      let boxY0 = 0;

      const bandBox = (x1: number, y1: number) => {
        const rect = canvas.getBoundingClientRect();
        return {
          left: Math.min(boxX0, x1) - rect.left,
          top: Math.min(boxY0, y1) - rect.top,
          width: Math.abs(x1 - boxX0),
          height: Math.abs(y1 - boxY0),
        };
      };

      const drawBand = (x1: number, y1: number) => {
        const band = bandRef.current;
        if (!band) return;
        const { left, top, width, height } = bandBox(x1, y1);
        band.style.display = 'block';
        band.style.left = `${left}px`;
        band.style.top = `${top}px`;
        band.style.width = `${width}px`;
        band.style.height = `${height}px`;
      };

      const hideBand = () => {
        boxing = false;
        if (bandRef.current) bandRef.current.style.display = 'none';
      };

      const finishBox = (x1: number, y1: number) => {
        hideBand();
        if (!pickIndex || !livePositions) return;
        const rect = canvas.getBoundingClientRect();
        const a = camera.worldAt((boxX0 - rect.left) * dpr, (boxY0 - rect.top) * dpr);
        const b = camera.worldAt((x1 - rect.left) * dpr, (y1 - rect.top) * dpr);
        const t0 = performance.now();
        const found = nodesInRect(
          pickIndex,
          livePositions,
          Math.min(a.x, b.x),
          Math.min(a.y, b.y),
          Math.max(a.x, b.x),
          Math.max(a.y, b.y),
          MAX_BOX_SELECTION,
        );
        // Shares `pickMs`: both are the same question of the same index, and a
        // second HUD reading for the rarer one would be noise.
        stats.pickMs = performance.now() - t0;

        // A box replaces whatever single node was selected — one highlight, so
        // one selection — and, being a different selection, releases whatever
        // the last one was isolating.
        setIsolate(false);
        selectedNode = -1;
        boxActive = true;
        setSelected(null);
        setNeighborhood(null);
        setSelectionOverlay(found.nodes, null);
        maskRef.current = found.mask;
        pushStyle();

        const listed: NodeRef[] = [];
        for (let i = 0; i < Math.min(found.nodes.length, NEIGHBOR_LIST_LIMIT); i++) {
          listed.push(describe(found.nodes[i]));
        }
        setBoxSelection({ total: found.total, listed });
      };

      /** Re-read the two contacts; called on every pinch frame and at its start. */
      const measurePinch = () => {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        pinchX = (a.x + b.x) / 2;
        pinchY = (a.y + b.y) / 2;
      };

      const onPointerDown = (e: PointerEvent) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return; // right/middle must not select
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        canvas.setPointerCapture(e.pointerId);
        if (pointers.size === 1) {
          dragging = true;
          travel = 0;
          lastX = downX = e.clientX;
          lastY = downY = e.clientY;
          // Box select takes the drag; panning is still available through the
          // mode toggle, and shift is a mouse-only shortcut into it.
          if (boxModeRef.current || e.shiftKey) {
            boxing = true;
            boxX0 = e.clientX;
            boxY0 = e.clientY;
          }
          return;
        }
        // A second finger turns the gesture into a pinch. The pan (or box) it
        // grew out of ends here, and `travel` is poisoned so the release
        // cannot be mistaken for a tap on whatever is under the last finger up.
        dragging = false;
        hideBand();
        travel = Infinity;
        if (pointers.size === 2) measurePinch();
      };
      const onPointerMove = (e: PointerEvent) => {
        const tracked = pointers.get(e.pointerId);
        if (tracked) {
          tracked.x = e.clientX;
          tracked.y = e.clientY;
        }
        if (pointers.size >= 2) {
          // Pinch: the midpoint pans and the separation zooms, both anchored
          // at the midpoint so the world stays put under the fingers.
          const before = { d: pinchDist, x: pinchX, y: pinchY };
          measurePinch();
          const rect = canvas.getBoundingClientRect();
          camera.panBy((pinchX - before.x) * dpr, (pinchY - before.y) * dpr);
          if (before.d > 0 && pinchDist > 0) {
            camera.zoomAt(
              pinchDist / before.d,
              (pinchX - rect.left) * dpr,
              (pinchY - rect.top) * dpr,
            );
          }
          return;
        }
        if (boxing) {
          travel = Math.max(travel, Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY));
          drawBand(e.clientX, e.clientY);
          return;
        }
        if (dragging) {
          camera.panBy((e.clientX - lastX) * dpr, (e.clientY - lastY) * dpr);
          lastX = e.clientX;
          lastY = e.clientY;
          travel = Math.max(travel, Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY));
          return;
        }
        if (touchy(e)) return; // no hover without a cursor to hover with
        const node = pickAt(e.clientX, e.clientY, pickRadius(e));
        if (node === hoverNode) return;
        hoverNode = node;
        uploadOverlay();
        setHover(node >= 0 ? describe(node) : null);
        canvas.style.cursor = node >= 0 ? 'pointer' : 'default';
      };
      const onPointerUp = (e: PointerEvent) => {
        const wasPinching = pointers.size >= 2;
        pointers.delete(e.pointerId);
        if (wasPinching) {
          // Whatever is left has to be re-seated before the next move, or the
          // camera jumps by the gap between the finger that went and the ones
          // that stayed: a pan from the surviving contact, or — with three
          // fingers down — a pinch measured on the new leading pair.
          const rest = [...pointers.values()];
          if (rest.length >= 2) measurePinch();
          else if (rest.length === 1) {
            dragging = true;
            lastX = downX = rest[0].x;
            lastY = downY = rest[0].y;
            travel = Infinity; // a pinch never ends in a selection
          }
          return;
        }
        // Only a gesture that began on the canvas selects: releasing here
        // after a press that started in the sidebar is not a click on a node.
        if (!dragging) return;
        dragging = false;
        const slop = touchy(e) ? TOUCH_CLICK_SLOP_PX : CLICK_SLOP_PX;
        if (boxing) {
          // A press that never moved is a click that happened to be in box
          // mode, not a zero-area rectangle selecting nothing.
          const dragged = Math.max(
            Math.abs(e.clientX - boxX0),
            Math.abs(e.clientY - boxY0),
          );
          if (dragged >= MIN_BOX_PX) finishBox(e.clientX, e.clientY);
          else {
            hideBand();
            select(pickAt(e.clientX, e.clientY, pickRadius(e)), hopsRef.current);
          }
          return;
        }
        if (travel > slop) return;
        select(pickAt(e.clientX, e.clientY, pickRadius(e)), hopsRef.current);
      };
      // Without this, a UA-cancelled gesture leaves `dragging` latched: the
      // camera then pans with no button held and, worse, pointermove never
      // reaches the pick branch again — hover and selection die for good.
      const onPointerCancel = (e: PointerEvent) => {
        pointers.delete(e.pointerId);
        if (pointers.size >= 2) measurePinch();
        dragging = false;
        hideBand();
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
        stats.zoom = camera.zoom;
        renderer!.render(view, drawLimits(view));
        if (captureRequest) {
          const resolve = captureRequest;
          captureRequest = null;
          // Synchronous with respect to the buffer: toBlob snapshots the
          // canvas at call time and only the encoding is deferred.
          canvas.toBlob((blob) => resolve(blob), 'image/png');
        }
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
          fitBox = { minX, minY, maxX, maxY };
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
  }, [graph, seed, worker, describe, composeStyle, pushStyle, setIsolate]);

  // A re-layout invalidates every coordinate, so the old selection means
  // nothing visually; clear the explore panel with it.
  useEffect(() => {
    setHover(null);
    setSelected(null);
    setNeighborhood(null);
    setBoxSelection(null);
    maskRef.current = null;
    setIsolate(false);
  }, [seed, setIsolate]);

  /** Re-walk from the current selection when the depth changes. */
  const changeHops = useCallback(
    (next: number) => {
      const clamped = Math.min(MAX_HOPS, Math.max(1, Math.round(next)));
      hopsRef.current = clamped;
      setHops(clamped);
      if (selected) viewApi.current?.select(selected.node, clamped);
    },
    [selected],
  );

  // Attribute values are fetched for the *selection* only, never for hover:
  // hover changes at pointer rate and this is a round trip to a query engine
  // (D12 draws the same line for the neighbourhood query).
  useEffect(() => {
    const store = storeRef.current;
    if (!store || !selected) {
      setAttrValues(null);
      return;
    }
    let cancelled = false;
    void store
      .values(selected.node)
      .then((values) => {
        if (!cancelled) setAttrValues(values);
      })
      .catch(() => {
        if (!cancelled) setAttrValues(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, storeVersion]);

  /** Which export is mid-flight, for the button's own feedback. A million-row
   * CSV takes long enough that a silent button reads as a broken one. */
  const [exporting, setExporting] = useState<'png' | 'csv' | null>(null);

  const exportPng = useCallback(async () => {
    setExporting('png');
    try {
      const blob = await viewApi.current?.capture();
      if (blob) download(blob, `${exportStem(name, seed)}.png`);
    } finally {
      setExporting(null);
    }
  }, [name, seed]);

  const exportPositions = useCallback(async () => {
    const positions = viewApi.current?.positions();
    if (!positions) return;
    setExporting('csv');
    // Yield once so the disabled state paints before the main thread goes away
    // for a second or two building the rows.
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      download(
        positionsCsv(graph.idBytes, graph.idOffsets, positions),
        `${exportStem(name, seed)}-positions.csv`,
      );
    } finally {
      setExporting(null);
    }
  }, [graph, name, seed]);

  const pick = useCallback((node: number) => {
    viewApi.current?.select(node, hopsRef.current);
    if (node >= 0) viewApi.current?.focus(node);
  }, []);

  // On a phone the panel is a sheet over the canvas, so a tap that selects a
  // node has to raise it — otherwise the tap's whole result is off-screen.
  useEffect(() => {
    if (narrow && selected) setPanelOpen(true);
  }, [narrow, selected]);

  return (
    <div
      className="graph-view"
      data-testid="graph-view"
      data-panel={narrow ? (panelOpen ? 'open' : 'closed') : 'docked'}
    >
      <div className="graph-hud">
        <span className="hud-title">
          <strong>{name}</strong> — {graph.nodeCount.toLocaleString()} nodes,{' '}
          {graph.edgeCount.toLocaleString()} edges
        </span>
        {/* Everything that is a reading or a knob, kept together so a narrow
            screen can drop the lot onto its own row under the title. */}
        <span className="hud-stats">
          {drawn && (drawn.edges < graph.edgeCount || drawn.nodes < graph.nodeCount) && (
            <span data-testid="draw-sample">
              seeded sample: {drawn.edges.toLocaleString()} edges,{' '}
              {drawn.nodes.toLocaleString()} nodes — zoom in for more
            </span>
          )}
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
          {/* Built in the tab and handed over as a blob — the §7 guarantee
              covers getting results *out* as much as getting them in. */}
          <span className="hud-export">
            export
            <button
              onClick={() => void exportPng()}
              disabled={exporting !== null}
              title="the current view, as a PNG"
              data-testid="export-png"
            >
              {exporting === 'png' ? '…' : 'PNG'}
            </button>
            <button
              onClick={() => void exportPositions()}
              disabled={exporting !== null}
              title="every node's laid-out coordinates, as CSV"
              data-testid="export-positions"
            >
              {exporting === 'csv' ? '…' : 'coords'}
            </button>
          </span>
        </span>
        <button className="hud-close" onClick={onClose}>
          close
        </button>
      </div>
      {error ? (
        <p className="summary error" role="alert">
          render failed: {error}
        </p>
      ) : (
        <div className="graph-body">
          <div className={`canvas-wrap${boxMode ? ' boxing' : ''}`}>
            <canvas ref={canvasRef} aria-label="graph canvas" />
            <div className="select-band" ref={bandRef} aria-hidden="true" />
            {/* Touch has no wheel: pinch is implemented, but a one-thumb
                control that cannot be mistaken for a pan is what makes zoom
                discoverable. Useful with a mouse too. */}
            <div className="canvas-controls" data-testid="view-controls">
              <button
                aria-label="box select"
                aria-pressed={boxMode}
                title="box select (or hold shift and drag)"
                data-testid="box-select-toggle"
                className={boxMode ? 'active' : undefined}
                onClick={() => {
                  boxModeRef.current = !boxMode;
                  setBoxMode(!boxMode);
                }}
              >
                ▭
              </button>
              <button
                aria-label="zoom in"
                title="zoom in"
                onClick={() => viewApi.current?.zoomBy(ZOOM_STEP)}
              >
                +
              </button>
              <button
                aria-label="zoom out"
                title="zoom out"
                onClick={() => viewApi.current?.zoomBy(1 / ZOOM_STEP)}
              >
                −
              </button>
              <button
                aria-label="fit graph to view"
                title="fit graph to view"
                onClick={() => viewApi.current?.resetView()}
              >
                ⤢
              </button>
            </div>
          </div>

          <aside className="explore" aria-label="explore panel">
            {narrow && (
              <button
                className="sheet-handle"
                data-testid="explore-toggle"
                aria-expanded={panelOpen}
                onClick={() => setPanelOpen((open) => !open)}
              >
                <span className="grip" aria-hidden="true" />
                {panelOpen ? 'hide panel' : selected ? selected.id : 'search, colour, filter'}
              </button>
            )}
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

            {hover && !selected && !boxSelection && (
              <div className="node-card" data-testid="hover-card">
                <h3>{hover.id}</h3>
                <p className="muted">degree {hover.degree.toLocaleString()}</p>
              </div>
            )}

            {boxSelection && (
              <div className="node-card selected" data-testid="box-card">
                <h3>{boxSelection.total.toLocaleString()} nodes selected</h3>
                {boxSelection.total === 0 ? (
                  <p className="muted">that rectangle is empty — drag another</p>
                ) : (
                  <>
                    <div className="hop-controls">
                      <label className="isolate">
                        <input
                          type="checkbox"
                          checked={isolated}
                          data-testid="box-isolate-toggle"
                          onChange={(e) => setIsolate(e.target.checked)}
                        />
                        isolate
                      </label>
                    </div>
                    <ul className="neighbors" data-testid="box-list">
                      {boxSelection.listed.map((n) => (
                        <li key={n.node}>
                          <button onClick={() => pick(n.node)}>{n.id}</button>
                          <em className="muted">{n.degree}</em>
                        </li>
                      ))}
                    </ul>
                    {boxSelection.total > boxSelection.listed.length && (
                      <p className="muted">
                        listing {boxSelection.listed.length} of{' '}
                        {boxSelection.total.toLocaleString()}
                      </p>
                    )}
                  </>
                )}
                <button onClick={() => pick(-1)}>clear selection</button>
              </div>
            )}

            {selected && (
              <div className="node-card selected" data-testid="selection-card">
                <h3>{selected.id}</h3>
                <p className="muted">
                  degree {selected.degree.toLocaleString()}
                  {neighborhood
                    ? ` · ${neighborhood.total.toLocaleString()} within ${
                        neighborhood.hops === 1 ? '1 hop' : `${neighborhood.hops} hops`
                      }`
                    : ' · finding neighbours…'}
                </p>
                <div className="hop-controls">
                  <span className="muted">hops</span>
                  {/* A row of depths rather than a stepper: there are five of
                      them, each is one worker round trip, and seeing which one
                      is current matters more than saving three characters. */}
                  {Array.from({ length: MAX_HOPS }, (_, i) => i + 1).map((k) => (
                    <button
                      key={k}
                      className={k === hops ? 'hop current' : 'hop'}
                      aria-pressed={k === hops}
                      aria-label={`expand ${k} ${k === 1 ? 'hop' : 'hops'}`}
                      data-testid={`hop-${k}`}
                      onClick={() => changeHops(k)}
                    >
                      {k}
                    </button>
                  ))}
                  <label className="isolate">
                    <input
                      type="checkbox"
                      checked={isolated}
                      disabled={!neighborhood}
                      data-testid="isolate-toggle"
                      onChange={(e) => setIsolate(e.target.checked)}
                    />
                    isolate
                  </label>
                </div>
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

            {selected && attrValues && Object.keys(attrValues).length > 0 && (
              <dl className="attr-card" data-testid="attribute-card">
                {Object.entries(attrValues).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}

            {!selected && !hover && !search && !boxSelection && (
              <p className="muted hint">
                Hover a node for its id and degree, click to select it and highlight its
                neighbours. From there, expand the walk to 5 hops and isolate what it
                reaches. Shift-drag — or the ▭ button — selects a whole rectangle.
                Picking wakes up once the layout settles.
              </p>
            )}

            <AttributesPanel
              graph={graph}
              worker={worker}
              attached={attached}
              onStyle={applyStyle}
              onStore={handleStore}
            />
          </aside>
        </div>
      )}
    </div>
  );
}
