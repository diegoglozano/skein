// Message protocol between the main thread and the ingest worker. Plain data
// only — buffers stay in the worker (persisted to OPFS) until M2's render
// path needs them transferred.

import type { LayoutProgress } from '../layout/params';

export type { LayoutProgress };

export interface IngestOptions {
  hasHeader: boolean;
  sourceCol: number;
  targetCol: number;
  /** -1 = unweighted. */
  weightCol: number;
  /** Single-byte delimiter, e.g. ','. */
  delimiter: string;
}

export const DEFAULT_INGEST_OPTIONS: IngestOptions = {
  hasHeader: true,
  sourceCol: 0,
  targetCol: 1,
  weightCol: -1,
  delimiter: ',',
};

export type IngestStage = 'parse' | 'build' | 'persist';

export interface GraphSummary {
  id: string;
  name: string;
  sizeBytes: number;
  importedAt: string;
  nodeCount: number;
  edgeCount: number;
  skippedRows: number;
  weighted: boolean;
  header?: string[];
  timings?: { parseMs: number; buildMs: number; persistMs: number };
}

export type ToWorker =
  | { type: 'ingest'; file: File; options: IngestOptions }
  | { type: 'list' }
  | { type: 'verify'; id: string }
  | { type: 'load'; id: string }
  | { type: 'hierarchy'; id: string }
  /** Run the whole multilevel layout in WASM (the no-WebGPU tier). */
  | { type: 'layout'; id: string; seed: number }
  /** Abandon an in-flight `layout` (view closed, or the seed changed). */
  | { type: 'cancel-layout' }
  | { type: 'save-positions'; id: string; seed: number; positions: Float32Array }
  | { type: 'load-positions'; id: string; seed: number }
  /** 1-hop neighbourhood of `node`, both edge directions (M4 selection). */
  | { type: 'neighbors'; id: string; node: number };

/** One level of the §6 multilevel hierarchy; level 0 is the symmetrized
 * input. `parentMap` is absent on the coarsest level. */
export interface HierarchyLevelBuffers {
  offsets: Uint32Array;
  targets: Uint32Array;
  weights: Float32Array;
  parentMap?: Uint32Array;
}

/** Flat render-ready buffers (§4.2); positions come from layout (M3) or a
 * deterministic seed until then. Transferred, not copied. */
export interface LoadedGraph {
  id: string;
  nodeCount: number;
  edgeCount: number;
  /** Endpoint node indices, interleaved [s0, t0, s1, t1, ...], length 2m. */
  endpoints: Uint32Array;
  /** Concatenated UTF-8 node ids; slice with `idOffsets` (§4.2 dictionary). */
  idBytes: Uint8Array;
  /** Length nodeCount + 1. */
  idOffsets: Uint32Array;
  /** Total degree (out + in) per node. */
  degrees: Uint32Array;
}

export type FromWorker =
  | {
      type: 'progress';
      stage: IngestStage;
      bytesRead: number;
      totalBytes: number;
      nodes: number;
      edges: number;
    }
  | { type: 'done'; graph: GraphSummary }
  | { type: 'graphs'; graphs: GraphSummary[] }
  | { type: 'verified'; id: string; ok: boolean; detail: string }
  | { type: 'loaded'; graph: LoadedGraph }
  | { type: 'hierarchy'; id: string; levels: HierarchyLevelBuffers[] }
  /** `positions` is a live preview of the finest level, transferred, and only
   * present on some ticks. */
  | ({ type: 'layout-progress'; id: string; positions?: Float32Array } & LayoutProgress)
  | { type: 'layout-done'; id: string; seed: number; positions: Float32Array }
  | { type: 'positions-saved'; id: string }
  | { type: 'positions'; id: string; seed: number; positions: Float32Array | null }
  /** `neighbors` is deduped and capped for display; `total` is the true count. */
  | { type: 'neighbors'; id: string; node: number; neighbors: Uint32Array; total: number }
  /** `request` is the message that failed. Listeners must check it: the
   * layout waiter and the ingest UI share this channel, and an untagged error
   * from a click-rate query used to abort an in-flight layout. */
  | { type: 'error'; message: string; request?: ToWorker['type'] };
