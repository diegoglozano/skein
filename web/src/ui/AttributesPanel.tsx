// The attributes half of M4 (REQUIREMENTS.md §10): attach a node-attributes
// file, colour and size nodes by a column, filter on one.
//
// The panel starts switched off. Turning it on is what loads DuckDB — a one-time
// payload big enough (D14) that a session which never asks for attributes should
// never pay for it, and the button says so rather than making the user guess.
// A graph that already has a file attached turns it on by itself: that choice
// was made last time.

import { useCallback, useEffect, useRef, useState } from 'react';
// Types only: the analytics module pulls in apache-arrow, and a static import
// would put it — and the DuckDB bundle URLs with it — in the entry chunk of a
// session that never opens this panel. `enable()` imports it for real.
import type {
  AttributeColumn,
  AttributeStore,
  Filter,
  Histogram,
  JoinReport,
} from '../analytics/attributes';
import { MAX_CATEGORIES, NEUTRAL_COLOR, SEQUENTIAL_STEPS, categoryHex } from '../analytics/palette';
import { readAttributesFile } from '../analytics/persist';
import type { LoadedGraph, ToWorker } from '../workers/protocol';

type Phase = 'off' | 'loading' | 'ready' | 'error';

function Legend({ column }: { column: AttributeColumn }) {
  if (column.kind === 'numeric') {
    return (
      <div className="legend" data-testid="colour-legend">
        <div className="ramp">
          {SEQUENTIAL_STEPS.map((hex) => (
            <span key={hex} style={{ background: hex }} />
          ))}
        </div>
        <div className="ramp-labels muted">
          <span>{(column.min ?? 0).toLocaleString()}</span>
          <span>{(column.max ?? 0).toLocaleString()}</span>
        </div>
      </div>
    );
  }
  const shown = column.categories ?? [];
  const rest = (column.distinct ?? 0) - shown.length;
  return (
    <ul className="legend swatches" data-testid="colour-legend">
      {shown.map((value, i) => (
        <li key={value}>
          <span className="swatch" style={{ background: categoryHex(i) }} />
          {value}
        </li>
      ))}
      {rest > 0 && (
        <li>
          <span className="swatch" style={{ background: NEUTRAL_COLOR }} />
          other ({rest.toLocaleString()} more {rest === 1 ? 'value' : 'values'})
        </li>
      )}
    </ul>
  );
}

/** A numeric column's distribution, so a range filter is aimed rather than guessed. */
function Sparkbars({ histogram }: { histogram: Histogram }) {
  const peak = Math.max(1, ...histogram.counts);
  return (
    <div className="sparkbars" aria-hidden="true">
      {histogram.counts.map((n, i) => (
        <span key={i} style={{ height: `${Math.round((n / peak) * 100)}%` }} />
      ))}
    </div>
  );
}

function FilterControl({
  column,
  filter,
  histogram,
  onChange,
}: {
  column: AttributeColumn;
  filter: Filter | undefined;
  histogram: Histogram | null;
  onChange: (next: Filter | null) => void;
}) {
  if (column.kind === 'numeric') {
    const lo = filter?.kind === 'range' ? filter.min : (column.min ?? 0);
    const hi = filter?.kind === 'range' ? filter.max : (column.max ?? 0);
    return (
      <>
        {histogram && <Sparkbars histogram={histogram} />}
        <div className="range">
          <input
            type="number"
            value={lo}
            aria-label={`${column.name} minimum`}
            onChange={(e) =>
              onChange({ column: column.name, kind: 'range', min: Number(e.target.value), max: hi })
            }
          />
          <input
            type="number"
            value={hi}
            aria-label={`${column.name} maximum`}
            onChange={(e) =>
              onChange({ column: column.name, kind: 'range', min: lo, max: Number(e.target.value) })
            }
          />
        </div>
        {filter && (
          <button className="link" onClick={() => onChange(null)}>
            clear filter
          </button>
        )}
      </>
    );
  }

  const chosen = new Set(filter?.kind === 'in' ? filter.values : []);
  const values = column.topValues ?? [];
  const hidden = (column.distinct ?? 0) - values.length;
  return (
    <>
      <ul className="values">
        {values.map(({ value, count }) => (
          <li key={value}>
            <label>
              <input
                type="checkbox"
                checked={chosen.has(value)}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(value);
                  else next.delete(value);
                  onChange(
                    next.size === 0
                      ? null
                      : { column: column.name, kind: 'in', values: [...next] },
                  );
                }}
              />
              {value}
            </label>
            <em className="muted">{count.toLocaleString()}</em>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p className="muted">
          {hidden.toLocaleString()} rarer {hidden === 1 ? 'value is' : 'values are'} not listed
        </p>
      )}
    </>
  );
}

export function AttributesPanel({
  graph,
  worker,
  attached,
  onStyle,
  onStore,
}: {
  graph: LoadedGraph;
  worker: Worker;
  /** What the manifest remembers, if a file was attached in a past session. */
  attached: { fileName: string; joinColumn: string } | null;
  onStyle: (style: Uint32Array | null) => void;
  onStore: (store: AttributeStore | null) => void;
}) {
  const [phase, setPhase] = useState<Phase>('off');
  const [error, setError] = useState<string | null>(null);
  const [columns, setColumns] = useState<AttributeColumn[]>([]);
  const [report, setReport] = useState<JoinReport | null>(null);
  const [fileColumns, setFileColumns] = useState<string[]>([]);
  const [colorBy, setColorBy] = useState<string | null>(null);
  const [sizeBy, setSizeBy] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [visible, setVisible] = useState<number | null>(null);
  const [histograms, setHistograms] = useState<Record<string, Histogram>>({});

  const storeRef = useRef<AttributeStore | null>(null);
  /**
   * The attached file, kept so changing the join column can re-read it without
   * going back to OPFS — the worker's copy is written asynchronously and may
   * not exist yet when the user changes the column right after attaching.
   */
  const fileRef = useRef<File | Blob | null>(null);
  /** Bumped on unmount so a late query can't style a view that is gone. */
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    return () => {
      if (generation.current !== mine) return;
      generation.current++;
      const store = storeRef.current;
      storeRef.current = null;
      onStore(null);
      store?.close().catch(() => {});
    };
  }, [graph, onStore]);

  const enable = useCallback(async () => {
    if (phase === 'loading' || phase === 'ready') return;
    const mine = generation.current;
    setPhase('loading');
    setError(null);
    try {
      const { AttributeStore } = await import('../analytics/attributes');
      const store = await AttributeStore.create(graph);
      if (generation.current !== mine) {
        await store.close().catch(() => {});
        return;
      }
      // A file attached in a past session is re-read from OPFS rather than
      // asked for again — it is the same bytes, and DuckDB takes the `File`
      // handle straight from storage.
      if (attached) {
        const file = await readAttributesFile(graph.id);
        if (file) {
          const restored = await store.attach(file, attached.fileName, attached.joinColumn);
          fileRef.current = file;
          setReport(restored);
          setFileColumns(await store.attachedColumns());
        }
      }
      if (generation.current !== mine) {
        await store.close().catch(() => {});
        return;
      }
      storeRef.current = store;
      setColumns(store.columns());
      setPhase('ready');
      onStore(store);
    } catch (err) {
      if (generation.current !== mine) return;
      setPhase('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [attached, graph, onStore, phase]);

  // A graph that already carries attributes opens with them loaded: the cost
  // was accepted when the file was attached.
  useEffect(() => {
    if (attached && phase === 'off') void enable();
  }, [attached, enable, phase]);

  const attach = useCallback(
    async (file: File, joinColumn?: string) => {
      const store = storeRef.current;
      if (!store) return;
      const mine = generation.current;
      try {
        const result = await store.attach(file, file.name, joinColumn);
        if (generation.current !== mine) return;
        fileRef.current = file;
        setReport(result);
        setFileColumns(await store.attachedColumns());
        setColumns(store.columns());
        setColorBy(null);
        setSizeBy(null);
        setFilters([]);
        setHistograms({});
        worker.postMessage({
          type: 'save-attributes',
          id: graph.id,
          file,
          joinColumn: result.joinColumn,
        } satisfies ToWorker);
      } catch (err) {
        if (generation.current !== mine) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [graph.id, worker],
  );

  // Every control change is one query and one buffer upload; the renderer is
  // told `null` when nothing is set, which puts it back on the flat colouring
  // rather than on a buffer of neutral values it would still have to sample.
  useEffect(() => {
    const store = storeRef.current;
    if (phase !== 'ready' || !store) return;
    const mine = generation.current;
    if (!colorBy && !sizeBy && filters.length === 0) {
      setVisible(null);
      onStyle(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await store.style({ colorBy, sizeBy, filters });
        if (cancelled || generation.current !== mine) return;
        setVisible(filters.length > 0 ? result.visible : null);
        onStyle(result.style);
      } catch (err) {
        if (cancelled || generation.current !== mine) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [colorBy, filters, onStyle, phase, sizeBy]);

  const setFilter = useCallback((column: string, next: Filter | null) => {
    setFilters((current) => {
      const rest = current.filter((f) => f.column !== column);
      return next ? [...rest, next] : rest;
    });
  }, []);

  const loadHistogram = useCallback(async (name: string) => {
    const store = storeRef.current;
    if (!store) return;
    const mine = generation.current;
    const histogram = await store.histogram(name);
    if (!histogram || generation.current !== mine) return;
    setHistograms((current) => ({ ...current, [name]: histogram }));
  }, []);

  // Anything short of `ready` has no store behind it, a failed start included —
  // the controls would be inert, so offer the button again rather than show them.
  if (phase !== 'ready') {
    return (
      <section
        className="attributes"
        aria-label="attributes"
        data-testid="attributes"
        data-attached={attached ? attached.fileName : ''}
      >
        <h3>attributes</h3>
        {error && (
          <p className="summary error" role="alert" data-testid="attributes-error">
            {error}
          </p>
        )}
        <button
          onClick={() => void enable()}
          disabled={phase === 'loading'}
          data-testid="enable-attributes"
        >
          {phase === 'loading'
            ? 'starting the query engine…'
            : phase === 'error'
              ? 'try again'
              : 'colour, size and filter by data'}
        </button>
        <p className="muted">
          Loads a SQL engine (DuckDB) from this origin, once. Nothing leaves the tab —
          it runs on your machine like everything else here.
        </p>
      </section>
    );
  }

  // Only numeric columns can be sized by; everything, `degree` included, can be
  // coloured and filtered.
  const numeric = columns.filter((c) => c.kind === 'numeric');
  const colorColumn = colorBy ? columns.find((c) => c.name === colorBy) : undefined;

  return (
    <section
      className="attributes"
      aria-label="attributes"
      data-testid="attributes"
      data-attached={attached ? attached.fileName : ''}
    >
      <h3>attributes</h3>

      {error && (
        <p className="summary error" role="alert" data-testid="attributes-error">
          {error}
        </p>
      )}

      <label className="file-pick block">
        {report ? `replace ${report.fileName}` : 'attach a node attributes CSV'}
        <input
          type="file"
          accept=".csv,text/csv"
          hidden
          data-testid="attributes-file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void attach(file);
            e.target.value = '';
          }}
        />
      </label>

      {report && (
        <div className="join-report" data-testid="join-report">
          <p>
            joined on <code>{report.joinColumn}</code> —{' '}
            {report.matchedNodes.toLocaleString()} of {graph.nodeCount.toLocaleString()} nodes
            matched
          </p>
          {(report.unmatchedRows > 0 || report.duplicateRows > 0) && (
            <p className="muted">
              {report.unmatchedRows > 0 &&
                `${report.unmatchedRows.toLocaleString()} rows matched no node`}
              {report.unmatchedRows > 0 && report.duplicateRows > 0 && ' · '}
              {report.duplicateRows > 0 &&
                `${report.duplicateRows.toLocaleString()} duplicate keys ignored`}
            </p>
          )}
          {fileColumns.length > 1 && (
            <label>
              join on{' '}
              <select
                value={report.joinColumn}
                data-testid="join-column"
                onChange={async (e) => {
                  const source = fileRef.current ?? (await readAttributesFile(graph.id));
                  if (source) void attach(new File([source], report.fileName), e.target.value);
                }}
              >
                {fileColumns.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      <label>
        colour by{' '}
        <select
          value={colorBy ?? ''}
          data-testid="colour-by"
          onChange={(e) => setColorBy(e.target.value || null)}
        >
          <option value="">nothing</option>
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {colorColumn && <Legend column={colorColumn} />}
      {colorColumn?.kind === 'categorical' && (colorColumn.distinct ?? 0) > MAX_CATEGORIES && (
        <p className="muted">
          Only {MAX_CATEGORIES} values can be told apart by colour on this canvas, so the rest
          share one. Filter to compare the others.
        </p>
      )}

      <label>
        size by{' '}
        <select
          value={sizeBy ?? ''}
          data-testid="size-by"
          onChange={(e) => setSizeBy(e.target.value || null)}
        >
          <option value="">nothing</option>
          {numeric.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <div className="filters">
        <h4>filters</h4>
        {visible !== null && (
          <p className="muted" data-testid="filter-count">
            showing {visible.toLocaleString()} of {graph.nodeCount.toLocaleString()} nodes
          </p>
        )}
        {columns.map((column) => (
          <details
            key={column.name}
            data-testid={`filter-${column.name}`}
            onToggle={(e) => {
              if ((e.currentTarget as HTMLDetailsElement).open && column.kind === 'numeric') {
                void loadHistogram(column.name);
              }
            }}
          >
            <summary>
              {column.name} <em className="muted">{column.sqlType.toLowerCase()}</em>
            </summary>
            <FilterControl
              column={column}
              filter={filters.find((f) => f.column === column.name)}
              histogram={histograms[column.name] ?? null}
              onChange={(next) => setFilter(column.name, next)}
            />
          </details>
        ))}
        {filters.length > 0 && (
          <button className="link" onClick={() => setFilters([])} data-testid="clear-filters">
            clear all filters
          </button>
        )}
      </div>

      {!report && (
        <p className="muted">
          Without a file you can still colour, size and filter by <code>degree</code>. Attach a
          CSV whose first column holds node ids to bring in your own columns.
        </p>
      )}
    </section>
  );
}
