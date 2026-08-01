// Zoom-adaptive draw budget (DECISIONS.md D13).
//
// Neither renderer culls: every frame submits a fixed batch and the rasterizer
// throws away whatever falls outside the clip volume. So vertex work is
// constant at every zoom level and *fragment* work is what moves. D13 took
// that one step further and concluded the fit view is therefore the most
// expensive frame the app draws. Measurement says otherwise, in both
// directions, and the corrections are what this file now implements.
//
// The knob is the same seeded-prefix sample D8 already established. Instead of
// a constant prefix length tuned for the worst frame, hold the number of
// primitives that survive clipping roughly constant: draw `budget / f`, where
// `f` is the fraction of the graph inside the viewport. Zoomed out (f → 1)
// that is D8's cap unchanged; zoomed in it spends the headroom the fit view
// was reserving, which is fidelity we were previously throwing away.
//
// `f` alone is only half the story, and the missing half is where the app was
// actually slow. It saturates at 1 the moment the whole graph fits on screen —
// which is exactly when zooming out *starts* costing more, not less. Node
// quads are sized in device pixels, so zooming out does not shrink them; it
// packs the same unshrinking, alpha-blended quads onto a smaller and smaller
// patch of screen, and blended overdraw serialises per pixel. Measured on the
// reference laptop at 1M/10M: 57 fps at the fit view, 13.9 fps two wheel
// notches out, with the drawn counts and `f` bit-identical across both. The
// 100k fixture holds 60 fps through the same sweep, which isolates the driver
// to node count rather than edges.
//
// So the budget is per *on-screen pixel*, not per frame: multiply by
// `coverage`, the screen area the graph covers as a multiple of its fit-view
// area. Density is then `drawn · f / coverage`, and setting
// `drawn = budget · coverage / f` holds it constant. The fit view
// (coverage = 1, f = 1) is D8's cap exactly, and zooming out finally has a
// lever: verified on the reference laptop at a flat 60 fps across the sweep
// that previously fell to 7.8.
//
// The other correction is in the zoom-*in* direction, and it is why `maxEdges`
// dropped by more than 6×. Clipping does not make a zoomed-in frame cheap the
// way D13 assumed, because edges are lines whose *on-screen pixel length grows
// with zoom*: the surviving fraction falls, but each survivor costs more to
// fill, and the two effects substantially cancel. The worst frame in the whole
// sweep is about one wheel notch inside the fit view — 37.9 fps against the fit
// view's 55.7 — where the layout is spread over roughly twice the fit-view area
// with ~91% of it still on screen. Raising the edge count there, which is
// exactly what D13 prescribed, is the wrong direction.
//
// Nodes do not have this problem: they are fixed-size quads, so their fill is
// count × constant regardless of zoom. That asymmetry is the whole reason the
// two budgets behave differently.
//
// Two properties this must keep, both easy to lose:
//
//   - **A pure function of camera state (§6, D2).** The obvious way to write
//     adaptive quality is an fps feedback loop, which would make the picture
//     depend on machine load and frame history — same file + seed + camera
//     would stop giving the same image. Nothing here reads a clock. For the
//     same reason there is no temporal smoothing of `f`.
//   - **Density stays put, so no alpha compensation.** Holding the on-screen
//     count constant already holds apparent density constant: zooming in
//     shrinks the viewport and raises the sample rate together, so nodes
//     entering at the sample boundary replace nodes leaving at the viewport
//     edge. Scaling alpha by the sample fraction on top of that would
//     double-correct.

import { mulberry32 } from '../layout/params';

export interface LodBudget {
  /** On-screen node quads to aim for. */
  nodes: number;
  /** On-screen edges to aim for. */
  edges: number;
  /**
   * Hard ceiling on edges submitted per frame, whatever the zoom.
   *
   * Sampling is uniform over the *whole* graph, so showing every edge inside a
   * small viewport means submitting every edge in the file — and clipping
   * happens after the vertex shader, so those vertices still cost their
   * position fetch. Past this point the frame stops being fill-bound and
   * becomes vertex-bound, which sampling cannot fix; only real culling (a
   * spatial index over the layout) can. This is where that boundary sits.
   */
  maxEdges: number;
}

/**
 * Calibrated on the reference laptop (M3 MacBook Air, WebGPU/Metal, medium
 * 1M/10M) — see `bench/results/render-medium_csv-2026-08-01-*.json`.
 *
 * `edges` is D8's measured cap, confirmed rather than changed: the fit view
 * draws exactly it and holds 57 fps, comfortably over §9's 30 fps floor.
 * `nodes` stays at the full 1M tier because 1M quads at the fit view is what
 * that 57 fps already includes — it is `coverage`, not this number, that
 * thins the zoomed-out frames which used to collapse.
 *
 * `maxEdges` came down from D13's placeholder 2M, which was far into the
 * regime it was meant to mark. Minimum fps over a zoom-in sweep, by ceiling:
 * 2M → 5.1, 1M → 11.3, 500k → 20.4, 300k → 37.9. §9 wants ≥ 30 at this tier,
 * so 300k is the first value that holds, with the worst frame about one wheel
 * notch inside the fit view rather than at either extreme.
 *
 * That leaves `maxEdges === edges`, which is not a coincidence and is worth
 * stating plainly: **at the 1M/10M tier there is no edge headroom to spend**,
 * so the scaling term never raises the edge count above D8's cap and only ever
 * lowers it. The ceiling is still a separate knob because it binds differently
 * at other tiers, but D13's "zoomed in it spends the headroom the fit view was
 * reserving" does not survive measurement for edges here. See `screenCoverage`
 * for why — edge fill grows with zoom, so the headroom was never there.
 */
export const DEFAULT_BUDGET: LodBudget = {
  nodes: 1_000_000,
  edges: 300_000,
  maxEdges: 300_000,
};

export interface DrawLimits {
  /** Nodes to draw: a prefix of the shuffled node order. */
  nodeLimit: number;
  /** Edges to draw: a prefix of the shuffled endpoint pairs. */
  edgeLimit: number;
}

/**
 * How much of the graph to submit.
 *
 * `visibleFraction` is the share of the graph's nodes inside the viewport, from
 * the pick grid ([`visibleNodeCount`](../interact/pick.ts)). `coverage` is the
 * share of the *viewport* the graph's on-screen bounding box covers, from
 * [`screenCoverage`]. The two answer different questions and neither substitutes
 * for the other: `f` says how much of the graph survives clipping, `coverage`
 * says how few pixels it has to survive onto.
 *
 * Pass 1 for both when they are unknown — before the layout settles there is no
 * pick index and no extent — which yields the fixed caps this replaced.
 */
export function lodLimits(
  nodeCount: number,
  edgeCount: number,
  visibleFraction: number,
  coverage: number,
  budget: LodBudget = DEFAULT_BUDGET,
): DrawLimits {
  if (nodeCount <= 0) return { nodeLimit: 0, edgeLimit: 0 };
  // A NaN fraction (empty grid, degenerate viewport) must not propagate into
  // the draw call as a NaN instance count; treat it as "assume everything is
  // on screen", the conservative end.
  const f = Number.isFinite(visibleFraction)
    ? Math.min(1, Math.max(visibleFraction, 1 / nodeCount))
    : 1;
  // Same guard, same conservative default: coverage 1 is the fit view, where
  // this whole policy reduces to D8's fixed cap. Unlike `f` this is not capped
  // at 1 — zoomed in the graph genuinely covers more screen than it does at fit,
  // and that headroom is real.
  const c = Number.isFinite(coverage) && coverage > 0 ? coverage : 1;
  const scale = c / f;
  return {
    nodeLimit: clampDraw(budget.nodes * scale, nodeCount, nodeCount),
    // The visible fraction is measured over nodes and reused for edges. In a
    // force layout most edges are short, so the two track closely; the ones
    // that do not are the long hub edges, which stay on screen longer than
    // their endpoints suggest and make this a slight over-estimate of f —
    // i.e. it errs toward drawing fewer edges, which is the safe direction.
    edgeLimit: clampDraw(budget.edges * scale, edgeCount, Math.min(edgeCount, budget.maxEdges)),
  };
}

/**
 * Floor on what a frame draws, in primitives.
 *
 * Holding density constant is honest all the way down, and all the way down it
 * says to draw almost nothing: at 1/10000 of the fit zoom the graph is a few
 * pixels across and the physically correct sample is single digits. But a graph
 * that thins to one node reads as a bug rather than as a distant object, and
 * the frames this floor applies to are the cheapest ones the app ever draws —
 * there is no performance argument against spending a little there.
 */
const MIN_DRAW = 4096;

function clampDraw(want: number, total: number, ceiling: number): number {
  if (total <= 0) return 0;
  const floor = Math.min(MIN_DRAW, total);
  return Math.max(floor, Math.min(ceiling, Math.ceil(want)));
}

/**
 * The screen area the graph currently covers, as a multiple of the area it
 * covers at the fit view. 1 at the fit view by construction, above 1 zoomed in,
 * falling as the square of the zoom on the way out.
 *
 * Normalising against the *fit view* rather than the viewport is what keeps
 * D8's cap intact. The budget is a measurement taken at the fit view, so that
 * is the camera at which it must come out unscaled — and a graph is almost
 * never able to cover the whole viewport there, because `Camera.fit` matches
 * the tighter of the two axes and adds a margin. On this fixture (a square
 * layout in a 16:10 viewport) viewport-relative coverage is 0.54 at fit, which
 * would quietly thin the one frame the number was measured on.
 *
 * A bounding box is the right estimator *here* even though D13 rejected one for
 * `f`. That objection was that a force layout concentrates mass in cluster
 * cores, so box area badly estimates how many nodes a viewport contains — a
 * question about mass. This is a question about extent, where the box is not an
 * estimate at all: it is exactly the screen region the drawing can land in.
 */
export function screenCoverage(
  spanX: number,
  spanY: number,
  zoom: number,
  fitZoom: number,
  widthPx: number,
  heightPx: number,
): number {
  if (!(spanX > 0) || !(spanY > 0) || !(zoom > 0) || !(fitZoom > 0)) return 1;
  if (widthPx <= 0 || heightPx <= 0) return 1;
  // Clipped to the viewport at both zooms: past the fit view the graph runs off
  // the edges, and off-screen extent is not area anything is drawn onto.
  const areaAt = (z: number) =>
    Math.min(widthPx, spanX * z) * Math.min(heightPx, spanY * z);
  const fitArea = areaAt(fitZoom);
  if (!(fitArea > 0)) return 1;
  return areaAt(zoom) / fitArea;
}

/**
 * In-place seeded Fisher–Yates over endpoint pairs, so any prefix of the
 * buffer is an unbiased sample of the edge list (D8). Without it the prefix is
 * CSR order — every edge of the lowest-indexed nodes, which is interner
 * first-seen order and therefore whatever grouping the CSV happened to have.
 */
export function shuffleEdgePairs(endpoints: Uint32Array, seed: number): void {
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

/**
 * A seeded permutation of `0..n`, for the node pass — the same prefix-is-a-
 * sample trick as the edges. Node indices cannot be sampled by stride or by
 * prefix directly: index order is interner first-seen order, which correlates
 * with structure (in a preferential-attachment graph the low indices are the
 * hubs), so a prefix of it is the opposite of a random subset.
 *
 * This is a separate buffer rather than a reordering of `positions`, because
 * node indices are load-bearing everywhere else: the highlight overlay, the
 * pick grid and the id dictionary all address nodes by index.
 */
export function shuffledOrder(n: number, seed: number): Uint32Array {
  // Derived, not reused: drawing the k-th edge and the k-th node from the same
  // random stream would correlate the two samples.
  const rand = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  return order;
}
