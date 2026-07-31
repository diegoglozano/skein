// Ingest worker (§4 pipeline stages Read → Parse/Intern/CSR → Persist).
// Streams the file — never `text()`s it — through the WASM IngestSession in
// chunks, then persists the flat buffers to OPFS. All hot-path data stays in
// typed arrays; this file only moves bytes and posts progress.

import init, { IngestSession } from '../wasm-pkg/skein_wasm';
import wasmUrl from '../wasm-pkg/skein_wasm_bg.wasm?url';
import type { FromWorker, GraphSummary, IngestOptions, ToWorker } from './protocol';
import {
  graphId,
  listGraphs,
  loadGraphEdges,
  persistGraphBuffers,
  verifyGraph,
  writeManifest,
  type GraphBuffers,
} from './opfs';

const PROGRESS_INTERVAL_MS = 150;

const ready = init({ module_or_path: wasmUrl });

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

async function ingest(file: File, options: IngestOptions) {
  await ready;

  // Capacity hint only — the interner grows as needed.
  const expectedNodes = Math.min(1 << 22, Math.max(1 << 10, Math.floor(file.size / 32)));
  const session = new IngestSession(
    expectedNodes,
    options.hasHeader,
    options.sourceCol,
    options.targetCol,
    options.weightCol,
    options.delimiter.charCodeAt(0),
  );

  const totalBytes = file.size;
  let bytesRead = 0;
  let lastProgress = 0;
  const t0 = performance.now();

  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    session.push_chunk(value);
    bytesRead += value.byteLength;
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
  const id = graphId(file);
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
    name: file.name,
    sizeBytes: file.size,
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

onmessage = async (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'ingest':
        await ingest(msg.file, msg.options);
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
        const { nodeCount, edgeCount, endpoints } = await loadGraphEdges(msg.id);
        postMessage(
          {
            type: 'loaded',
            graph: { id: msg.id, nodeCount, edgeCount, endpoints },
          } satisfies FromWorker,
          { transfer: [endpoints.buffer] },
        );
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
