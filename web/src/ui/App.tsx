import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  FromWorker,
  GraphSummary,
  IngestStage,
  LoadedGraph,
  ToWorker,
} from '../workers/protocol';
import type { IngestOptions } from '../workers/protocol';
import {
  DEFAULT_SAMPLE,
  SAMPLE_LIMITS,
  grouped,
  sampleSpecError,
  type SampleSpec,
} from '../workers/generate';
import { ColumnMapping } from './ColumnMapping';
import { GraphView } from './GraphView';

const STAGE_LABELS: Record<IngestStage, string> = {
  generate: 'generating edges',
  parse: 'parsing + interning',
  build: 'building CSR',
  persist: 'writing to browser storage',
};

interface Progress {
  stage: IngestStage;
  bytesRead: number;
  totalBytes: number;
  nodes: number;
  edges: number;
}

type IngestState =
  | { phase: 'idle' }
  | { phase: 'working'; progress: Progress }
  | { phase: 'done'; graph: GraphSummary }
  | { phase: 'error'; message: string };

export function App() {
  const [showVerify, setShowVerify] = useState(false);
  const [state, setState] = useState<IngestState>({ phase: 'idle' });
  const [recent, setRecent] = useState<GraphSummary[]>([]);
  const [verifyResult, setVerifyResult] = useState<{ id: string; detail: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Kept as strings: a half-typed field is a string, and coercing it to a
  // number on every keystroke turns "" into 0 and fights the user's backspace.
  const [nodeInput, setNodeInput] = useState(String(DEFAULT_SAMPLE.nodes));
  const [edgeInput, setEdgeInput] = useState(String(DEFAULT_SAMPLE.edges));
  const [viewing, setViewing] = useState<{ graph: LoadedGraph; summary: GraphSummary } | null>(
    null,
  );
  const workerRef = useRef<Worker | null>(null);
  // Summaries by id, so the view can be handed the manifest — the attributes
  // panel needs to know whether a file was attached in a previous session.
  const summariesRef = useRef<Map<string, GraphSummary>>(new Map());

  useEffect(() => {
    const worker = new Worker(new URL('../workers/ingest.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'progress':
          setState({ phase: 'working', progress: msg });
          break;
        case 'done':
          setState({ phase: 'done', graph: msg.graph });
          worker.postMessage({ type: 'list' } satisfies ToWorker);
          break;
        case 'graphs':
          setRecent(msg.graphs);
          for (const g of msg.graphs) summariesRef.current.set(g.id, g);
          break;
        case 'attributes-saved':
          // The manifest changed under the open view; keep the cached summary
          // in step so closing and reopening restores the attachment.
          summariesRef.current.set(msg.graph.id, msg.graph);
          setRecent((current) =>
            current.map((g) => (g.id === msg.graph.id ? msg.graph : g)),
          );
          break;
        case 'verified':
          setVerifyResult({ id: msg.id, detail: `${msg.ok ? '✓' : '✗'} ${msg.detail}` });
          break;
        case 'loaded': {
          const summary = summariesRef.current.get(msg.graph.id);
          setViewing({
            graph: msg.graph,
            summary: summary ?? {
              id: msg.graph.id,
              name: msg.graph.id,
              sizeBytes: 0,
              importedAt: '',
              nodeCount: msg.graph.nodeCount,
              edgeCount: msg.graph.edgeCount,
              skippedRows: 0,
              weighted: false,
            },
          });
          break;
        }
        case 'error':
          setState({ phase: 'error', message: msg.message });
          break;
      }
    };
    worker.postMessage({ type: 'list' } satisfies ToWorker);
    return () => worker.terminate();
  }, []);

  /** A dropped file waiting on the column mapping dialog (§10). */
  const [pending, setPending] = useState<File | null>(null);

  const ingest = useCallback((file: File, options: IngestOptions) => {
    setPending(null);
    setVerifyResult(null);
    setState({
      phase: 'working',
      progress: { stage: 'parse', bytesRead: 0, totalBytes: file.size, nodes: 0, edges: 0 },
    });
    workerRef.current?.postMessage({ type: 'ingest', file, options } satisfies ToWorker);
  }, []);

  const generate = useCallback((spec: SampleSpec) => {
    setVerifyResult(null);
    setState({
      phase: 'working',
      progress: { stage: 'generate', bytesRead: 0, totalBytes: 0, nodes: spec.nodes, edges: 0 },
    });
    workerRef.current?.postMessage({ type: 'generate', spec } satisfies ToWorker);
  }, []);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    const file = event.dataTransfer.files[0];
    if (file) setPending(file);
  }, []);

  const openGraph = useCallback((summary: GraphSummary) => {
    // The cache is fed by the worker (`graphs`, `attributes-saved`) and is the
    // authority. `summary` may be the ingest-time snapshot behind "open graph",
    // which was captured before any attributes file existed and never learns
    // about one — writing it over a newer manifest loses the attachment.
    if (!summariesRef.current.has(summary.id)) summariesRef.current.set(summary.id, summary);
    workerRef.current?.postMessage({ type: 'load', id: summary.id } satisfies ToWorker);
  }, []);

  const requestedSample: SampleSpec = { nodes: Number(nodeInput), edges: Number(edgeInput) };
  const sampleError =
    nodeInput.trim() === '' || edgeInput.trim() === ''
      ? 'enter a node count and an edge count'
      : sampleSpecError(requestedSample);

  if (viewing && workerRef.current) {
    return (
      <GraphView
        graph={viewing.graph}
        name={viewing.summary.name}
        attached={viewing.summary.attributes ?? null}
        worker={workerRef.current}
        onClose={() => {
          setViewing(null);
          workerRef.current?.postMessage({ type: 'list' } satisfies ToWorker);
        }}
      />
    );
  }

  return (
    <div className="shell">
      <header>
        <h1>skein</h1>
        <button className="privacy-badge" onClick={() => setShowVerify((v) => !v)}>
          ● your data never leaves this tab
        </button>
      </header>

      {showVerify && (
        <aside className="verify">
          <h2>Verify it yourself</h2>
          <p>
            skein makes zero network requests after the page loads. To confirm: open
            devtools (F12) → Network tab → clear the log → load a graph file. The log
            stays empty — parsing, layout, and storage all happen in this tab. A
            Content-Security-Policy on this page additionally blocks requests to any
            other origin, and an automated test enforces this on every change.
          </p>
        </aside>
      )}

      {pending ? (
        <ColumnMapping
          file={pending}
          onCancel={() => setPending(null)}
          onImport={(options) => ingest(pending, options)}
        />
      ) : (
      <main
        className={`dropzone${dragOver ? ' dragover' : ''}`}
        aria-label="file drop zone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <p>Drop an edge list here — CSV, one edge per row</p>
        <p className="muted">
          You pick the columns and the delimiter next, over a preview of the file.
          Parquet and Arrow land later.
        </p>
        <label className="file-pick">
          or choose a file
          <input
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) setPending(file);
              e.target.value = '';
            }}
          />
        </label>

        <section className="samples" aria-label="sample graphs">
          <h2>No data on this device?</h2>
          <p className="muted">
            Say how big, and one is synthesized here in the tab — a scale-free graph
            of that size, the same kind the project benchmarks against — then put
            through the ordinary import. Nothing is downloaded.
          </p>
          <form
            className="sample-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!sampleError) generate(requestedSample);
            }}
          >
            <label>
              nodes
              <input
                type="number"
                inputMode="numeric"
                min={SAMPLE_LIMITS.minNodes}
                max={SAMPLE_LIMITS.maxNodes}
                step={1}
                value={nodeInput}
                onChange={(e) => setNodeInput(e.target.value)}
                data-testid="generate-nodes"
              />
            </label>
            <label>
              edges
              <input
                type="number"
                inputMode="numeric"
                min={SAMPLE_LIMITS.minEdges}
                max={SAMPLE_LIMITS.maxEdges}
                step={1}
                value={edgeInput}
                onChange={(e) => setEdgeInput(e.target.value)}
                data-testid="generate-edges"
              />
            </label>
            <button
              type="submit"
              disabled={state.phase === 'working' || sampleError !== null}
              data-testid="generate-run"
            >
              generate graph
            </button>
          </form>
          {sampleError ? (
            <p className="sample-note error" role="alert" data-testid="generate-error">
              {sampleError}
            </p>
          ) : (
            <p className="sample-note muted">
              up to {grouped(SAMPLE_LIMITS.maxNodes)} nodes and{' '}
              {grouped(SAMPLE_LIMITS.maxEdges)} edges, at least one edge per node. A
              million nodes is minutes, not seconds.
            </p>
          )}
        </section>

        {state.phase === 'working' && (
          <div className="progress" role="status">
            <p>
              {STAGE_LABELS[state.progress.stage]} —{' '}
              {state.progress.stage === 'generate'
                ? `${state.progress.edges.toLocaleString()} edges of a ${state.progress.nodes.toLocaleString()}-node graph`
                : `${state.progress.nodes.toLocaleString()} nodes, ${state.progress.edges.toLocaleString()} edges`}
            </p>
            <progress
              value={state.progress.stage === 'parse' ? state.progress.bytesRead : undefined}
              max={state.progress.totalBytes}
            />
          </div>
        )}

        {state.phase === 'done' && (
          <div className="summary" role="status" data-testid="ingest-summary">
            <p>
              <strong>{state.graph.name}</strong> — {state.graph.nodeCount.toLocaleString()}{' '}
              nodes, {state.graph.edgeCount.toLocaleString()} edges
              {state.graph.skippedRows > 0 && `, ${state.graph.skippedRows} rows skipped`}
            </p>
            {state.graph.timings && (
              <p className="muted">
                parse {state.graph.timings.parseMs} ms · build {state.graph.timings.buildMs} ms
                · persist {state.graph.timings.persistMs} ms — stored in this browser
              </p>
            )}
            <button onClick={() => openGraph(state.graph)}>
              open graph
            </button>
          </div>
        )}

        {state.phase === 'error' && (
          <div className="summary error" role="alert">
            <p>ingest failed: {state.message}</p>
          </div>
        )}
      </main>
      )}

      {recent.length > 0 && (
        <section className="recent" aria-label="recent graphs">
          <h2>On this device</h2>
          <ul>
            {recent.map((g) => (
              <li key={g.id}>
                <span>
                  {g.name} — {g.nodeCount.toLocaleString()} nodes,{' '}
                  {g.edgeCount.toLocaleString()} edges
                </span>
                <button onClick={() => openGraph(g)}>open</button>
                <button
                  onClick={() => {
                    setVerifyResult(null);
                    workerRef.current?.postMessage({ type: 'verify', id: g.id } satisfies ToWorker);
                  }}
                >
                  check storage
                </button>
                {verifyResult?.id === g.id && <em>{verifyResult.detail}</em>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
