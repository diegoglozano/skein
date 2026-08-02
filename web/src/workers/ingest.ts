// Ingest worker (§4 pipeline stages Read → Parse/Intern/CSR → Persist).
// Streams the file — never `text()`s it — through the WASM IngestSession in
// chunks, then persists the flat buffers to OPFS. All hot-path data stays in
// typed arrays; this file only moves bytes and posts progress.

import init, {
  build_layout_hierarchy,
  node_neighbors,
  total_degrees,
  IngestSession,
  LayoutSession,
} from '../wasm-pkg/skein_wasm';
import wasmUrl from '../wasm-pkg/skein_wasm_bg.wasm?url';
import type {
  FromWorker,
  GraphSummary,
  HierarchyLevelBuffers,
  IngestOptions,
  LayoutProgress,
  ToWorker,
} from './protocol';
import { DEFAULT_INGEST_OPTIONS } from './protocol';
import {
  csvByteLength,
  csvChunks,
  generateEdges,
  sampleGraphId,
  sampleGraphName,
  type SampleSpec,
} from './generate';
import {
  graphId,
  listGraphs,
  loadGraphCsr,
  loadGraphEdges,
  loadGraphDictionary,
  loadPositions,
  persistGraphBuffers,
  saveAttributes,
  savePositions,
  verifyGraph,
  writeManifest,
  type GraphBuffers,
} from './opfs';

const PROGRESS_INTERVAL_MS = 150;

/** Coarsening stops here; both layout paths must agree on the hierarchy. */
const HIERARCHY_TARGET_NODES = 10_000;
const HIERARCHY_MAX_LEVELS = 12;
/** Levels larger than this get prolongation only in the WASM tier — §8
 * graceful degradation past §9's top tier. Measured, not guessed: at 1M the
 * whole fallback layout is 23.9 s of the 45 s budget (DECISIONS.md D11). */
const WASM_MAX_SIM_NODES = 1_000_000;
/** Iterations per WASM `step` call — the yield granularity for progress. */
const LAYOUT_CHUNK_ITERS = 4;

const ready = init({ module_or_path: wasmUrl });

/** Bumped by every `layout`/`cancel-layout` message; an in-flight run whose
 * epoch is stale abandons itself at the next chunk boundary. */
let layoutEpoch = 0;

/** Most neighbours we hand back for one selection. The UI highlights them and
 * lists a prefix; a 1M-degree hub would blow both up for no readable gain. */
const NEIGHBOR_CAP = 20_000;

/**
 * Last graph's directed CSR, so repeated selections don't re-read 44 MB from
 * OPFS per click. One graph is enough: the view shows one at a time.
 *
 * Cached as a *promise*, not a value: `onmessage` is async and several
 * handlers want the CSR, so two overlapping requests would otherwise both
 * call `loadGraphCsr` — and OPFS grants only one sync access handle per file,
 * so the loser rejects with NoModificationAllowedError.
 */
let csrCache: { id: string; csr: Promise<CsrBuffers> } | null = null;

interface CsrBuffers {
  offsets: Uint32Array;
  targets: Uint32Array;
}

function cachedCsr(id: string): Promise<CsrBuffers> {
  if (csrCache?.id !== id) {
    csrCache = {
      id,
      // Drop a failed read so the next request retries instead of caching it.
      csr: loadGraphCsr(id).catch((err) => {
        if (csrCache?.id === id) csrCache = null;
        throw err;
      }),
    };
  }
  return csrCache.csr;
}

/** 1-hop neighbourhood, both directions. The traversal itself is
 * `skein_core::neighbors` — algorithms stay in the core crate, natively
 * tested; this only moves buffers. */
async function neighbors(id: string, node: number) {
  await ready;
  const { offsets, targets } = await cachedCsr(id);
  const { neighbors: list, total } = node_neighbors(offsets, targets, node, NEIGHBOR_CAP) as {
    neighbors: Uint32Array;
    total: number;
  };
  postMessage({ type: 'neighbors', id, node, neighbors: list, total } satisfies FromWorker, {
    transfer: [list.buffer],
  });
}

function post(msg: FromWorker) {
  postMessage(msg);
}

interface FinishResult {
  offsets: Uint32Array;
  targets: Uint32Array;
  weights?: Float32Array;
  idBytes: Uint8Array;
  idOffsets: Uint32Array;
  header?: string[];
  nodeCount: number;
  edgeCount: number;
  skippedRows: number;
}

/**
 * Where the CSV bytes come from. A dropped file streams from disk; a generated
 * sample streams straight out of `generate.ts`. Everything downstream of here
 * — parser, interner, CSR, OPFS, manifest — must not be able to tell which,
 * which is the whole reason generation produces bytes rather than a CSR.
 */
interface IngestSource {
  id: string;
  name: string;
  /** For a generated graph, the size of the CSV that was fed to the parser —
   * there is no file on the device to ask. */
  sizeBytes: number;
  /** Progress-bar denominator; equal to `sizeBytes` for both sources today. */
  totalBytes: number;
  /** Capacity hint for the interner only — it grows as needed. */
  expectedNodes: number;
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

async function* fileChunks(file: File): AsyncGenerator<Uint8Array> {
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

async function ingest(file: File, options: IngestOptions) {
  await ready;
  await ingestSource(
    {
      id: graphId(file),
      name: file.name,
      sizeBytes: file.size,
      totalBytes: file.size,
      expectedNodes: Math.min(1 << 22, Math.max(1 << 10, Math.floor(file.size / 32))),
      chunks: fileChunks(file),
    },
    options,
  );
}

async function ingestSource(source: IngestSource, options: IngestOptions) {
  const session = new IngestSession(
    source.expectedNodes,
    options.hasHeader,
    options.sourceCol,
    options.targetCol,
    options.weightCol,
    options.delimiter.charCodeAt(0),
  );

  const totalBytes = source.totalBytes;
  let bytesRead = 0;
  let lastProgress = 0;
  const t0 = performance.now();

  for await (const chunk of source.chunks) {
    session.push_chunk(chunk);
    bytesRead += chunk.byteLength;
    const now = performance.now();
    if (now - lastProgress > PROGRESS_INTERVAL_MS) {
      lastProgress = now;
      post({
        type: 'progress',
        stage: 'parse',
        bytesRead,
        totalBytes,
        nodes: session.node_count(),
        edges: session.edge_count(),
      });
    }
  }
  const parseMs = Math.round(performance.now() - t0);

  post({
    type: 'progress',
    stage: 'build',
    bytesRead,
    totalBytes,
    nodes: session.node_count(),
    edges: session.edge_count(),
  });
  const t1 = performance.now();
  const result = session.finish() as FinishResult;
  const buildMs = Math.round(performance.now() - t1);

  post({
    type: 'progress',
    stage: 'persist',
    bytesRead,
    totalBytes,
    nodes: result.nodeCount,
    edges: result.edgeCount,
  });
  const t2 = performance.now();
  const id = source.id;
  const buffers: GraphBuffers = {
    offsets: result.offsets,
    targets: result.targets,
    weights: result.weights,
    idBytes: result.idBytes,
    idOffsets: result.idOffsets,
  };
  await persistGraphBuffers(id, buffers, result.nodeCount, result.edgeCount);
  const persistMs = Math.round(performance.now() - t2);

  const summary: GraphSummary = {
    id,
    name: source.name,
    sizeBytes: source.sizeBytes,
    importedAt: new Date().toISOString(),
    nodeCount: result.nodeCount,
    edgeCount: result.edgeCount,
    skippedRows: result.skippedRows,
    weighted: result.weights !== undefined,
    header: result.header,
    timings: { parseMs, buildMs, persistMs },
  };
  await writeManifest(id, summary);
  post({ type: 'done', graph: summary });
}

/**
 * Synthesize a sample graph and push it through `ingestSource`. Generation is
 * a blocking loop rather than a chunked one — this is a worker, so the UI is
 * unaffected, and the only cost of blocking is that `cancel-layout` and
 * friends wait, which nothing is doing while the drop zone is busy.
 */
async function generateSample(spec: SampleSpec) {
  await ready;

  // No byte counts yet — the CSV does not exist until the arrays do — so the
  // bar stays indeterminate here and `edges` is what moves.
  const progress = (edges: number) =>
    post({
      type: 'progress',
      stage: 'generate',
      bytesRead: 0,
      totalBytes: 0,
      nodes: spec.nodes,
      edges,
    });
  progress(0);
  const edges = generateEdges(spec, progress);
  const sizeBytes = csvByteLength(edges);

  await ingestSource(
    {
      id: sampleGraphId(spec),
      name: sampleGraphName(spec),
      sizeBytes,
      totalBytes: sizeBytes,
      expectedNodes: spec.nodes,
      chunks: csvChunks(edges),
    },
    DEFAULT_INGEST_OPTIONS,
  );
}

/** Let the worker's message queue drain, so `cancel-layout` can land. */
const yieldToQueue = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * The no-WebGPU layout tier: hierarchy + multilevel force sim run entirely in
 * WASM (skein-core), stepped in small chunks so progress and a live preview of
 * the finest level can be posted between them. The WebGPU tier does this on
 * the main thread with the WGSL engine instead.
 */
async function layout(id: string, seed: number, epoch: number) {
  await ready;
  const { offsets, targets } = await cachedCsr(id);
  const session = new LayoutSession(
    offsets,
    targets,
    seed >>> 0,
    HIERARCHY_TARGET_NODES,
    HIERARCHY_MAX_LEVELS,
    WASM_MAX_SIM_NODES,
  );
  try {
    let lastPreview = 0;
    for (;;) {
      if (layoutEpoch !== epoch) return;
      const done = session.step(LAYOUT_CHUNK_ITERS);
      if (done) break;
      const p = session.progress() as unknown as LayoutProgress;
      const now = performance.now();
      // Preview only at the finest level — that is what the view renders.
      const preview =
        p.level === p.levels && now - lastPreview > PROGRESS_INTERVAL_MS
          ? session.positions()
          : undefined;
      if (preview) lastPreview = now;
      postMessage(
        { type: 'layout-progress', id, ...p, positions: preview } satisfies FromWorker,
        preview ? { transfer: [preview.buffer] } : undefined,
      );
      await yieldToQueue();
    }
    if (layoutEpoch !== epoch) return;
    const positions = session.positions();
    postMessage({ type: 'layout-done', id, seed, positions } satisfies FromWorker, {
      transfer: [positions.buffer],
    });
  } finally {
    session.free();
  }
}

onmessage = async (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'ingest':
        // Re-importing the same file reuses its graph id and rewrites csr.bin,
        // so a cached CSR would answer later queries from the old graph.
        csrCache = null;
        await ingest(msg.file, msg.options);
        break;
      case 'generate':
        // Regenerating the same size rewrites its csr.bin under the same id —
        // same reason `ingest` drops the cache.
        csrCache = null;
        await generateSample(msg.spec);
        break;
      case 'list':
        post({ type: 'graphs', graphs: await listGraphs() });
        break;
      case 'verify': {
        const { ok, detail } = await verifyGraph(msg.id);
        post({ type: 'verified', id: msg.id, ok, detail });
        break;
      }
      case 'load': {
        await ready;
        const { nodeCount, edgeCount, endpoints, offsets, targets } = await loadGraphEdges(msg.id);
        // csr.bin is read exactly once per open: seed the cache with what we
        // just read, so the hierarchy and the first selection reuse it.
        csrCache = { id: msg.id, csr: Promise.resolve({ offsets, targets }) };
        const degrees = total_degrees(offsets, targets);
        const { idBytes, idOffsets } = await loadGraphDictionary(msg.id);
        postMessage(
          {
            type: 'loaded',
            graph: { id: msg.id, nodeCount, edgeCount, endpoints, idBytes, idOffsets, degrees },
          } satisfies FromWorker,
          {
            transfer: [endpoints.buffer, idBytes.buffer, idOffsets.buffer, degrees.buffer],
          },
        );
        break;
      }
      case 'neighbors':
        await neighbors(msg.id, msg.node);
        break;
      case 'hierarchy': {
        await ready;
        const { offsets, targets } = await cachedCsr(msg.id);
        const levels = build_layout_hierarchy(
          offsets,
          targets,
          HIERARCHY_TARGET_NODES,
          HIERARCHY_MAX_LEVELS,
        ) as unknown as HierarchyLevelBuffers[];
        postMessage({ type: 'hierarchy', id: msg.id, levels } satisfies FromWorker, {
          transfer: levels.flatMap((l) =>
            [l.offsets.buffer, l.targets.buffer, l.weights.buffer].concat(
              l.parentMap ? [l.parentMap.buffer] : [],
            ),
          ),
        });
        break;
      }
      case 'layout':
        await layout(msg.id, msg.seed, ++layoutEpoch);
        break;
      case 'cancel-layout':
        layoutEpoch++;
        break;
      case 'save-attributes': {
        const graph = await saveAttributes(msg.id, msg.file, msg.joinColumn);
        post({ type: 'attributes-saved', id: msg.id, graph });
        break;
      }
      case 'save-positions': {
        await savePositions(msg.id, msg.seed, msg.positions);
        post({ type: 'positions-saved', id: msg.id });
        break;
      }
      case 'load-positions': {
        const positions = await loadPositions(msg.id, msg.seed);
        postMessage(
          { type: 'positions', id: msg.id, seed: msg.seed, positions } satisfies FromWorker,
          positions ? { transfer: [positions.buffer] } : undefined,
        );
        break;
      }
    }
  } catch (err) {
    post({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      request: msg.type,
    });
  }
};
