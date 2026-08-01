// Renderer contract (M2, DECISIONS.md D7). Everything crossing this boundary
// is a flat typed array (§4.2): positions are xy-interleaved world
// coordinates, edges are endpoint index pairs. No per-node/per-edge objects.

export interface RenderGraph {
  nodeCount: number;
  edgeCount: number;
  /** World-space xy, length 2 * nodeCount. */
  positions: Float32Array;
  /**
   * Endpoint node indices, interleaved [s0, t0, s1, t1, ...], length
   * 2 * edgeCount. Pre-shuffled with a seeded permutation, so any prefix is an
   * unbiased sample (D8) — see `lod.ts`.
   */
  endpoints: Uint32Array;
  /**
   * Node indices in draw order, length nodeCount: a seeded permutation, for
   * the same prefix-is-a-sample reason as `endpoints`. The node pass reads
   * positions through it rather than by instance index.
   */
  nodeOrder: Uint32Array;
}

/**
 * How much of the graph to submit this frame; see `lod.ts`. The highlight
 * overlay is exempt — a selected or hovered node must stay on screen even when
 * the sample would have dropped it.
 */
export interface DrawLimits {
  /** Nodes to draw, as a prefix of `nodeOrder`. Undefined draws all. */
  nodeLimit?: number;
  /** Edges to draw, as a prefix of `endpoints`. Undefined draws all. */
  edgeLimit?: number;
}

/** World→clip mapping plus device info, computed by the camera per frame. */
export interface ViewTransform {
  /** clip = world * scale + offset (x and y independently). */
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  /** Canvas size in device pixels. */
  widthPx: number;
  heightPx: number;
  /** Node quad size in device pixels. */
  pointSizePx: number;
}

export type Backend = 'webgpu' | 'webgl2';

export interface Renderer {
  readonly backend: Backend;
  /** WebGPU only: the device, for compute passes sharing this context. */
  readonly device?: GPUDevice;
  /** Upload graph buffers; may be called again to swap graphs. */
  setGraph(graph: RenderGraph): void;
  /** Re-upload node positions (CPU-side layout path). */
  updatePositions(positions: Float32Array): void;
  /**
   * Overlay a highlighted subset (M4 hover/selection). Drawn on top of the
   * base passes in an accent colour and at a larger point size, so the base
   * buffers stay untouched and unhighlighted frames cost nothing extra.
   * `nodes` are node indices; `edges` are endpoint index pairs
   * [s0, t0, s1, t1, ...]. Empty arrays clear the overlay.
   */
  setHighlight(nodes: Uint32Array, edges: Uint32Array): void;
  /**
   * WebGPU only: the live positions storage buffer, so a compute sim on the
   * same device can copyBufferToBuffer into it without a CPU round trip.
   */
  positionsGpuBuffer?(): GPUBuffer | null;
  /**
   * Draw one frame. `limits` caps how much of the graph is submitted; both
   * caps are prefixes of the pre-shuffled buffers, so a capped frame is an
   * unbiased sample rather than a corner of the data. Omitted draws
   * everything.
   */
  render(view: ViewTransform, limits?: DrawLimits): void;
  /** Resize the drawing buffer to device pixels. */
  resize(widthPx: number, heightPx: number): void;
  dispose(): void;
}
