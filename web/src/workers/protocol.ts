// Message protocol between the main thread and the ingest worker. Plain data
// only — buffers stay in the worker (persisted to OPFS) until M2's render
// path needs them transferred.

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
  | { type: 'load'; id: string };

/** Flat render-ready buffers (§4.2); positions come from layout (M3) or a
 * deterministic seed until then. Transferred, not copied. */
export interface LoadedGraph {
  id: string;
  nodeCount: number;
  edgeCount: number;
  /** Endpoint node indices, interleaved [s0, t0, s1, t1, ...], length 2m. */
  endpoints: Uint32Array;
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
  | { type: 'error'; message: string };
