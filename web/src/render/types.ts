// Renderer contract (M2, DECISIONS.md D7). Everything crossing this boundary
// is a flat typed array (§4.2): positions are xy-interleaved world
// coordinates, edges are endpoint index pairs. No per-node/per-edge objects.

export interface RenderGraph {
  nodeCount: number;
  edgeCount: number;
  /** World-space xy, length 2 * nodeCount. */
  positions: Float32Array;
  /** Endpoint node indices, interleaved [s0, t0, s1, t1, ...], length 2 * edgeCount. */
  endpoints: Uint32Array;
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
  /** Upload graph buffers; may be called again to swap graphs. */
  setGraph(graph: RenderGraph): void;
  /**
   * Draw one frame. `edgeLimit` caps how many edges are drawn (a prefix of
   * the uploaded endpoint buffer — pre-shuffle it with a seeded permutation
   * for an unbiased sample). Undefined draws all edges.
   */
  render(view: ViewTransform, edgeLimit?: number): void;
  /** Resize the drawing buffer to device pixels. */
  resize(widthPx: number, heightPx: number): void;
  dispose(): void;
}
