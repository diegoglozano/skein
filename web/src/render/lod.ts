// Zoom-adaptive draw budget (DECISIONS.md D13).
//
// Neither renderer culls: every frame submits a fixed batch and the rasterizer
// throws away whatever falls outside the clip volume. So vertex work is
// constant at every zoom level and *fragment* work is what moves — at the fit
// view every primitive lands on screen at once and blended overdraw peaks,
// while zoomed in almost everything is clipped before it shades. That is the
// whole reason the app feels faster zoomed in, and it inverts the usual LOD
// rule: the level that needs decimating is the far one, not the near one.
//
// The knob is the same seeded-prefix sample D8 already established. Instead of
// a constant prefix length tuned for the worst frame, hold the number of
// primitives that survive clipping roughly constant: draw `budget / f`, where
// `f` is the fraction of the graph inside the viewport. Zoomed out (f → 1)
// that is D8's cap unchanged; zoomed in it spends the headroom the fit view
// was reserving, which is fidelity we were previously throwing away.
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
 * `edges` is D8's measured cap, unchanged — it is what ≥30 fps at the fit view
 * costs on the reference laptop, and at the fit view this policy still draws
 * exactly it. `nodes` is a no-op at §9's 1M tier (the whole graph is under
 * budget) and starts sampling at the 5M tier. Both, and `maxEdges`, want a
 * calibration run on real hardware — `tests/manual-render.mjs` reports fps per
 * zoom level for exactly that.
 */
export const DEFAULT_BUDGET: LodBudget = {
  nodes: 1_000_000,
  edges: 300_000,
  maxEdges: 2_000_000,
};

export interface DrawLimits {
  /** Nodes to draw: a prefix of the shuffled node order. */
  nodeLimit: number;
  /** Edges to draw: a prefix of the shuffled endpoint pairs. */
  edgeLimit: number;
}

/**
 * How much of the graph to submit, given the fraction of it currently inside
 * the viewport. `visibleFraction` comes from the pick grid
 * ([`visibleNodeCount`](../interact/pick.ts)); pass 1 when it is unknown —
 * before the layout settles there is no index yet — which yields the fixed
 * caps this replaced.
 */
export function lodLimits(
  nodeCount: number,
  edgeCount: number,
  visibleFraction: number,
  budget: LodBudget = DEFAULT_BUDGET,
): DrawLimits {
  if (nodeCount <= 0) return { nodeLimit: 0, edgeLimit: 0 };
  // A NaN fraction (empty grid, degenerate viewport) must not propagate into
  // the draw call as a NaN instance count; treat it as "assume everything is
  // on screen", the conservative end.
  const f = Number.isFinite(visibleFraction)
    ? Math.min(1, Math.max(visibleFraction, 1 / nodeCount))
    : 1;
  return {
    nodeLimit: Math.min(nodeCount, Math.ceil(budget.nodes / f)),
    // The visible fraction is measured over nodes and reused for edges. In a
    // force layout most edges are short, so the two track closely; the ones
    // that do not are the long hub edges, which stay on screen longer than
    // their endpoints suggest and make this a slight over-estimate of f —
    // i.e. it errs toward drawing fewer edges, which is the safe direction.
    edgeLimit: Math.min(edgeCount, budget.maxEdges, Math.ceil(budget.edges / f)),
  };
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
