// Column mapping (§10: "Format sniffing, column mapping dialog — source,
// target, optional weight and metadata join key").
//
// The whole `IngestOptions` shape has been plumbed through the worker and into
// the Rust parser since M1; only the dialog was missing, so an edge list whose
// columns were not the first two, or which was not comma-separated, could not
// be opened at all. Nothing here changes the ingest path — it chooses its
// arguments.
//
// The preview parser is a second, tiny CSV reader living beside the real one,
// which is a duplication worth naming. It exists because the authority
// (`skein_core::CsvScanner`) is instantiated in the worker behind a streaming
// ingest that produces a CSR and nothing else: there is no way to ask it "what
// would the first six rows look like under this delimiter?" without ingesting
// the file, which is the thing the user has not committed to yet. It reads
// only the first 64 KB, and it never decides anything — the row it shows and
// the row Rust parses can disagree only about a file the user is about to see
// the header of anyway.
//
// The "metadata join key" §10 also mentions is not here: attributes are
// attached later, from inside the graph view, and that dialog picks its own
// join column against columns this file does not have.

import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_INGEST_OPTIONS, type IngestOptions } from '../workers/protocol';

/** Enough for the header plus a few rows of any sane edge list. */
const HEAD_BYTES = 64 * 1024;
/** Data rows shown under the header. */
const PREVIEW_ROWS = 5;

const DELIMITERS = [
  { label: 'comma', value: ',' },
  { label: 'semicolon', value: ';' },
  { label: 'tab', value: '\t' },
  { label: 'pipe', value: '|' },
];

/** Column names worth guessing from, in preference order. */
const SOURCE_NAMES = ['source', 'src', 'from', 'node1', 'start', 'u'];
const TARGET_NAMES = ['target', 'dst', 'dest', 'to', 'node2', 'end', 'v'];
const WEIGHT_NAMES = ['weight', 'w', 'value', 'count'];

/**
 * Rows from a slice of CSV text, honouring RFC 4180 quotes so a quoted
 * delimiter or newline does not split a field. `complete` says whether the
 * text is the whole file: if it is not, the trailing row is dropped, because
 * a 64 KB slice almost always ends mid-line and half a row in the preview
 * would look like a parse bug.
 */
export function parseRows(
  text: string,
  delimiter: string,
  maxRows: number,
  complete: boolean,
): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      started = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
      started = false;
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      started = false;
    } else if (c !== '\r') {
      field += c;
      started = true;
    }
  }
  if (complete && rows.length < maxRows && (started || row.length)) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** The delimiter that splits the first line into the most fields. */
export function sniffDelimiter(text: string): string {
  let best = DEFAULT_INGEST_OPTIONS.delimiter;
  let bestFields = 1;
  for (const { value } of DELIMITERS) {
    const fields = parseRows(text, value, 1, true)[0]?.length ?? 1;
    if (fields > bestFields) {
      bestFields = fields;
      best = value;
    }
  }
  return best;
}

const numeric = (field: string) => field.trim() !== '' && Number.isFinite(Number(field));

/**
 * A first row with no numbers in it is a header. That is wrong for an
 * unheaded list of string ids — and is exactly the assumption the app made
 * unconditionally before this dialog existed, except that now the row is on
 * screen with a checkbox next to it.
 */
export function guessHeader(rows: string[][]): boolean {
  return rows.length > 0 && rows[0].every((field) => !numeric(field));
}

function guessColumn(labels: string[], names: string[], fallback: number): number {
  const normalized = labels.map((label) => label.trim().toLowerCase());
  for (const name of names) {
    const at = normalized.indexOf(name);
    if (at >= 0) return at;
  }
  return fallback;
}

interface Head {
  text: string;
  complete: boolean;
}

export function ColumnMapping({
  file,
  onCancel,
  onImport,
}: {
  file: File;
  onCancel: () => void;
  onImport: (options: IngestOptions) => void;
}) {
  const [head, setHead] = useState<Head | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [options, setOptions] = useState<IngestOptions>(DEFAULT_INGEST_OPTIONS);

  useEffect(() => {
    let cancelled = false;
    void file
      .slice(0, HEAD_BYTES)
      .text()
      .then((text) => {
        if (cancelled) return;
        setHead({ text, complete: file.size <= HEAD_BYTES });
        const delimiter = sniffDelimiter(text);
        const rows = parseRows(text, delimiter, PREVIEW_ROWS + 1, file.size <= HEAD_BYTES);
        const hasHeader = guessHeader(rows);
        const labels = hasHeader ? (rows[0] ?? []) : [];
        setOptions({
          delimiter,
          hasHeader,
          sourceCol: guessColumn(labels, SOURCE_NAMES, 0),
          targetCol: guessColumn(labels, TARGET_NAMES, 1),
          weightCol: guessColumn(labels, WEIGHT_NAMES, -1),
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setFailed(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const rows = useMemo(
    () =>
      head ? parseRows(head.text, options.delimiter, PREVIEW_ROWS + 1, head.complete) : [],
    [head, options.delimiter],
  );

  const columnCount = rows.reduce((most, row) => Math.max(most, row.length), 0);
  const labels = Array.from({ length: columnCount }, (_, i) =>
    options.hasHeader ? (rows[0]?.[i] ?? `column ${i + 1}`) : `column ${i + 1}`,
  );
  const dataRows = options.hasHeader ? rows.slice(1) : rows.slice(0, PREVIEW_ROWS);

  // Clamped rather than trusted: changing the delimiter re-splits the file
  // into a different number of columns, and a stale index would be read by the
  // parser as "that column is missing" on every row.
  const sourceCol = Math.min(options.sourceCol, columnCount - 1);
  const targetCol = Math.min(options.targetCol, columnCount - 1);
  const weightCol = options.weightCol >= columnCount ? -1 : options.weightCol;

  const problem =
    columnCount < 2
      ? `no ${DELIMITERS.find((d) => d.value === options.delimiter)?.label ?? ''}-separated columns found — try another delimiter`
      : sourceCol === targetCol
        ? 'source and target must be different columns'
        : null;

  const set = (patch: Partial<IngestOptions>) =>
    setOptions((current) => ({ ...current, ...patch }));

  const columnSelect = (
    id: string,
    value: number,
    onChange: (next: number) => void,
    optional = false,
  ) => (
    <select
      value={value}
      data-testid={id}
      onChange={(e) => onChange(Number(e.target.value))}
      aria-label={id.replace('mapping-', '')}
    >
      {optional && <option value={-1}>none</option>}
      {labels.map((label, i) => (
        <option key={i} value={i}>
          {label}
        </option>
      ))}
    </select>
  );

  return (
    <main className="mapping" data-testid="column-mapping">
      <h2>{file.name}</h2>
      {failed ? (
        <p className="summary error" role="alert">
          could not read the file: {failed}
        </p>
      ) : !head ? (
        <p className="muted">reading the first rows…</p>
      ) : (
        <>
          <p className="muted">
            Which columns hold the edge? Nothing is read past the first{' '}
            {(HEAD_BYTES / 1024).toFixed(0)} KB until you import.
          </p>

          <div className="mapping-controls">
            <label>
              delimiter
              <select
                value={options.delimiter}
                data-testid="mapping-delimiter"
                aria-label="delimiter"
                onChange={(e) => set({ delimiter: e.target.value })}
              >
                {DELIMITERS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="mapping-header">
              <input
                type="checkbox"
                checked={options.hasHeader}
                data-testid="mapping-header"
                onChange={(e) => set({ hasHeader: e.target.checked })}
              />
              first row is a header
            </label>
            <label>
              source
              {columnSelect('mapping-source', sourceCol, (v) => set({ sourceCol: v }))}
            </label>
            <label>
              target
              {columnSelect('mapping-target', targetCol, (v) => set({ targetCol: v }))}
            </label>
            <label>
              weight
              {columnSelect('mapping-weight', weightCol, (v) => set({ weightCol: v }), true)}
            </label>
          </div>

          {columnCount > 0 && (
            <div className="mapping-preview">
              <table data-testid="mapping-preview">
                <thead>
                  <tr>
                    {labels.map((label, i) => (
                      <th
                        key={i}
                        className={
                          i === sourceCol
                            ? 'is-source'
                            : i === targetCol
                              ? 'is-target'
                              : i === weightCol
                                ? 'is-weight'
                                : undefined
                        }
                      >
                        {label}
                        {i === sourceCol && <em>source</em>}
                        {i === targetCol && <em>target</em>}
                        {i === weightCol && <em>weight</em>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dataRows.map((row, r) => (
                    <tr key={r}>
                      {labels.map((_, c) => (
                        <td key={c}>{row[c] ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {problem && (
            <p className="sample-note error" role="alert" data-testid="mapping-error">
              {problem}
            </p>
          )}

          <div className="mapping-actions">
            <button
              data-testid="mapping-import"
              disabled={problem !== null}
              onClick={() =>
                onImport({
                  ...options,
                  sourceCol,
                  targetCol,
                  weightCol,
                })
              }
            >
              import
            </button>
            <button data-testid="mapping-cancel" onClick={onCancel}>
              cancel
            </button>
          </div>
        </>
      )}
    </main>
  );
}
