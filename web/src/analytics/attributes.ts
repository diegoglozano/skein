// Attribute store (M4, REQUIREMENTS.md §10; DECISIONS.md D4's two-file ingest).
//
// Everything the attribute surface needs — column discovery, type inference,
// the join onto node indices, filters, histograms — is SQL, per §5's "don't
// hand-roll this". What this module owns is the *shape* of the answer: queries
// come back as flat typed arrays indexed by node (§4.2), never as row objects,
// because the renderer consumes a buffer of length nodeCount every time a
// control moves.
//
// Two tables and a view:
//
//   nodes(idx, id, degree)   the graph itself, inserted as Arrow with no JS
//                            strings — `idOffsets`/`idBytes` already *are* the
//                            Arrow Utf8 layout, so the dictionary crosses over
//                            as two buffers rather than a million strings.
//   attrs_raw(...)           the attached CSV, types inferred by DuckDB.
//   node_attrs               nodes LEFT JOIN attrs_raw, the thing every query
//                            below reads. It exists (as just idx + degree)
//                            before any file is attached, which is why
//                            colour-by-degree and the degree histogram work
//                            with no second file at all.

import * as arrow from 'apache-arrow';
import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { openDatabase, registerFile } from './duckdb';
import { MAX_CATEGORIES, categoryRgb, neutralRgb, sequentialRgb } from './palette';
import { HIDDEN_SIZE_CODE, NEUTRAL_SIZE_CODE, packStyle, sizeCode } from '../render/style';

/** The registered name the attached file gets inside DuckDB's filesystem. */
const ATTRS_FILE = 'attrs.csv';

/** Bins in a numeric column's distribution strip. */
export const HISTOGRAM_BINS = 24;

/**
 * Distinct values kept per categorical column. Larger than the palette on
 * purpose: only the first `MAX_CATEGORIES` of them can be *coloured*, but the
 * filter list is readable well past that, and a column with 40 communities is
 * still worth filtering on even though it can't be coloured by.
 */
export const MAX_FILTER_VALUES = 12;

export type ColumnKind = 'numeric' | 'categorical';

export interface AttributeColumn {
  name: string;
  /** DuckDB's inferred type, shown as-is in the UI. */
  sqlType: string;
  kind: ColumnKind;
  /** Numeric only. Equal min and max means a constant column. */
  min?: number;
  max?: number;
  /**
   * Categorical only: the most common values, ties broken by value, capped at
   * `MAX_FILTER_VALUES`. Computed once from the whole column and never
   * recomputed — a filter must not repaint the values that survive it.
   */
  topValues?: { value: string; count: number }[];
  /** Categorical only: the prefix of `topValues` that gets its own colour. */
  categories?: string[];
  /** Categorical only: distinct values in total, `topValues` included. */
  distinct?: number;
  /** Rows where this column is null. */
  nulls: number;
}

export interface JoinReport {
  fileName: string;
  joinColumn: string;
  rows: number;
  /** Nodes that found a row. */
  matchedNodes: number;
  /** Attribute rows whose key matches no node in the graph. */
  unmatchedRows: number;
  /** Rows dropped because an earlier row claimed the same key. */
  duplicateRows: number;
}

export type Filter =
  | { column: string; kind: 'range'; min: number; max: number }
  | { column: string; kind: 'in'; values: string[] };

export interface StyleSpec {
  colorBy: string | null;
  sizeBy: string | null;
  filters: Filter[];
}

export interface StyleResult {
  style: Uint32Array;
  /** Nodes the filters kept; equals nodeCount when no filter is active. */
  visible: number;
}

export interface Histogram {
  min: number;
  max: number;
  /** Length HISTOGRAM_BINS. */
  counts: number[];
}

const NUMERIC_TYPES =
  /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|REAL|DECIMAL)/i;

function kindOf(sqlType: string): ColumnKind {
  return NUMERIC_TYPES.test(sqlType) ? 'numeric' : 'categorical';
}

/** Quote a SQL identifier. Column names come from a user's CSV header. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a SQL string literal. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The node dictionary as an Arrow IPC stream. `idOffsets` and `idBytes` are
 * bit-for-bit an Arrow Utf8 array's two buffers already (§4.2 stores the
 * dictionary exactly that way), so this reinterprets rather than converts —
 * building a million `string`s here was the alternative.
 */
function nodesIpc(
  nodeCount: number,
  idBytes: Uint8Array,
  idOffsets: Uint32Array,
  degrees: Uint32Array,
): Uint8Array {
  const idx = new Int32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) idx[i] = i;
  const table = new arrow.Table({
    idx: arrow.makeVector(idx),
    id: arrow.makeVector(
      arrow.makeData({
        type: new arrow.Utf8(),
        length: nodeCount,
        valueOffsets: new Int32Array(idOffsets.buffer, idOffsets.byteOffset, nodeCount + 1),
        data: idBytes,
      }),
    ),
    degree: arrow.makeVector(
      new Int32Array(degrees.buffer, degrees.byteOffset, nodeCount),
    ),
  });
  return arrow.tableToIPC(table, 'stream');
}

export interface GraphKeys {
  nodeCount: number;
  idBytes: Uint8Array;
  idOffsets: Uint32Array;
  degrees: Uint32Array;
}

export class AttributeStore {
  private constructor(
    private readonly db: AsyncDuckDB,
    private readonly conn: AsyncDuckDBConnection,
    readonly nodeCount: number,
    private cols: AttributeColumn[],
    private report: JoinReport | null,
  ) {}

  static async create(graph: GraphKeys): Promise<AttributeStore> {
    const db = await openDatabase();
    const conn = await db.connect();
    // Tables are database-wide and the database is a process-wide singleton, so
    // a previous graph's `nodes` would still be here if its store failed to
    // close. Dropping first turns that into a fresh join rather than an insert
    // into someone else's dictionary.
    await conn.query('DROP VIEW IF EXISTS node_attrs');
    await conn.query('DROP TABLE IF EXISTS nodes');
    await conn.insertArrowFromIPCStream(
      nodesIpc(graph.nodeCount, graph.idBytes, graph.idOffsets, graph.degrees),
      { name: 'nodes', create: true },
    );
    const store = new AttributeStore(db, conn, graph.nodeCount, [], null);
    await store.rebuildView(null);
    return store;
  }

  columns(): AttributeColumn[] {
    return this.cols;
  }

  column(name: string): AttributeColumn | undefined {
    return this.cols.find((c) => c.name === name);
  }

  joinReport(): JoinReport | null {
    return this.report;
  }

  /** Columns of the attached file, for the "join on" control. */
  async attachedColumns(): Promise<string[]> {
    if (!this.report) return [];
    const table = await this.conn.query(`DESCRIBE attrs_raw`);
    return [...table].map((row) => String(row?.column_name));
  }

  /**
   * Attach a node-attributes file, joined on `joinColumn` (default: its first
   * column). Replaces any previously attached file.
   */
  async attach(file: File | Blob, fileName: string, joinColumn?: string): Promise<JoinReport> {
    await registerFile(this.db, ATTRS_FILE, file);
    await this.conn.query(
      `CREATE OR REPLACE TABLE attrs_raw AS SELECT * FROM read_csv_auto(${literal(ATTRS_FILE)}, header = true)`,
    );
    const described = await this.conn.query(`DESCRIBE attrs_raw`);
    const names = [...described].map((row) => String(row?.column_name));
    if (names.length === 0) throw new Error(`${fileName} has no columns`);
    const key = joinColumn && names.includes(joinColumn) ? joinColumn : names[0];

    await this.rebuildView(key);

    const stats = await this.conn.query(`
      SELECT
        (SELECT count(*) FROM attrs_raw) AS rows,
        (SELECT count(DISTINCT CAST(${ident(key)} AS VARCHAR)) FROM attrs_raw) AS keys,
        (SELECT count(*) FROM nodes n
           WHERE EXISTS (SELECT 1 FROM attrs_raw a
                          WHERE CAST(a.${ident(key)} AS VARCHAR) = n.id)) AS matched,
        (SELECT count(*) FROM attrs_raw a
           WHERE NOT EXISTS (SELECT 1 FROM nodes n
                              WHERE n.id = CAST(a.${ident(key)} AS VARCHAR))) AS unmatched
    `);
    const row = stats.get(0);
    const rows = Number(row?.rows ?? 0);
    this.report = {
      fileName,
      joinColumn: key,
      rows,
      matchedNodes: Number(row?.matched ?? 0),
      unmatchedRows: Number(row?.unmatched ?? 0),
      duplicateRows: rows - Number(row?.keys ?? 0),
    };
    return this.report;
  }

  /**
   * Rebuild `node_attrs` and rescan the column metadata. `key` is null before
   * any file is attached, which leaves the view as the graph's own columns.
   *
   * The attached side is de-duplicated by key first: a second row for the same
   * id would otherwise multiply that node's row out of the join and quietly
   * break every count downstream.
   */
  private async rebuildView(key: string | null): Promise<void> {
    const sql = key
      ? `CREATE OR REPLACE VIEW node_attrs AS
           SELECT n.idx, n.degree, a.* EXCLUDE (${ident(key)})
           FROM nodes n
           LEFT JOIN (
             SELECT * FROM attrs_raw
             QUALIFY row_number() OVER (PARTITION BY CAST(${ident(key)} AS VARCHAR)) = 1
           ) a ON CAST(a.${ident(key)} AS VARCHAR) = n.id`
      : `CREATE OR REPLACE VIEW node_attrs AS SELECT idx, degree FROM nodes`;
    await this.conn.query(sql);
    this.cols = await this.scanColumns();
  }

  private async scanColumns(): Promise<AttributeColumn[]> {
    const described = await this.conn.query(`DESCRIBE node_attrs`);
    const found = [...described]
      .map((row) => ({ name: String(row?.column_name), sqlType: String(row?.column_type) }))
      .filter((c) => c.name !== 'idx');

    const columns: AttributeColumn[] = [];
    for (const { name, sqlType } of found) {
      const kind = kindOf(sqlType);
      const col = ident(name);
      if (kind === 'numeric') {
        const stats = await this.conn.query(
          `SELECT min(CAST(${col} AS DOUBLE)) AS lo, max(CAST(${col} AS DOUBLE)) AS hi,
                  count(*) FILTER (WHERE ${col} IS NULL) AS nulls
             FROM node_attrs`,
        );
        const row = stats.get(0);
        columns.push({
          name,
          sqlType,
          kind,
          min: row?.lo == null ? 0 : Number(row.lo),
          max: row?.hi == null ? 0 : Number(row.hi),
          nulls: Number(row?.nulls ?? 0),
        });
      } else {
        // Ordered by frequency with the value as tie-break, so the same file
        // always produces the same colour assignment (§6's determinism rule
        // applies to the picture, not just to the layout).
        const top = await this.conn.query(
          `SELECT CAST(${col} AS VARCHAR) AS v, count(*) AS n
             FROM node_attrs WHERE ${col} IS NOT NULL
            GROUP BY 1 ORDER BY n DESC, v ASC LIMIT ${MAX_FILTER_VALUES}`,
        );
        const stats = await this.conn.query(
          `SELECT count(DISTINCT CAST(${col} AS VARCHAR)) AS d,
                  count(*) FILTER (WHERE ${col} IS NULL) AS nulls
             FROM node_attrs`,
        );
        const row = stats.get(0);
        const topValues = [...top].map((r) => ({
          value: String(r?.v),
          count: Number(r?.n ?? 0),
        }));
        columns.push({
          name,
          sqlType,
          kind,
          topValues,
          categories: topValues.slice(0, MAX_CATEGORIES).map((t) => t.value),
          distinct: Number(row?.d ?? 0),
          nulls: Number(row?.nulls ?? 0),
        });
      }
    }
    return columns;
  }

  private whereClause(filters: Filter[]): string {
    if (filters.length === 0) return '';
    const terms = filters.map((f) => {
      const col = ident(f.column);
      if (f.kind === 'range') {
        // A half-typed or emptied number input reaches here as NaN. Treat it as
        // "no bound yet" rather than interpolating it into SQL, which would
        // fail the query and replace the graph with an error message while the
        // user is still typing.
        if (!Number.isFinite(f.min) || !Number.isFinite(f.max)) return 'true';
        return `CAST(${col} AS DOUBLE) BETWEEN ${f.min} AND ${f.max}`;
      }
      if (f.values.length === 0) return 'false';
      return `CAST(${col} AS VARCHAR) IN (${f.values.map(literal).join(', ')})`;
    });
    return `WHERE ${terms.join(' AND ')}`;
  }

  /**
   * The per-node style buffer for the current controls. Nodes the filters
   * exclude — and nodes the join left without a row, once any filter is active
   * — come back hidden; the renderer takes their edges with them.
   */
  async style(spec: StyleSpec): Promise<StyleResult> {
    const colorCol = spec.colorBy ? this.column(spec.colorBy) : undefined;
    const sizeCol = spec.sizeBy ? this.column(spec.sizeBy) : undefined;

    // -1 is the "no value" sentinel throughout: COALESCE keeps both result
    // columns as plain DOUBLEs, so they read back as typed arrays without
    // having to consult Arrow's validity bitmaps per row.
    let colorExpr = 'CAST(-1 AS DOUBLE)';
    if (colorCol?.kind === 'numeric') {
      const span = (colorCol.max ?? 0) - (colorCol.min ?? 0);
      colorExpr =
        span > 0
          ? `COALESCE((CAST(${ident(colorCol.name)} AS DOUBLE) - ${colorCol.min}) / ${span}, -1)`
          : `CASE WHEN ${ident(colorCol.name)} IS NULL THEN -1 ELSE 0.5 END`;
    } else if (colorCol?.kind === 'categorical') {
      const list = (colorCol.categories ?? []).map(literal).join(', ');
      colorExpr = list
        ? `COALESCE(CAST(list_position([${list}], CAST(${ident(colorCol.name)} AS VARCHAR)) AS DOUBLE), -1)`
        : 'CAST(-1 AS DOUBLE)';
    }

    let sizeExpr = 'CAST(-1 AS DOUBLE)';
    if (sizeCol?.kind === 'numeric') {
      const span = (sizeCol.max ?? 0) - (sizeCol.min ?? 0);
      sizeExpr =
        span > 0
          ? `COALESCE((CAST(${ident(sizeCol.name)} AS DOUBLE) - ${sizeCol.min}) / ${span}, -1)`
          : `CASE WHEN ${ident(sizeCol.name)} IS NULL THEN -1 ELSE 0.5 END`;
    }

    const table = await this.conn.query(
      `SELECT idx, ${colorExpr} AS c, ${sizeExpr} AS s FROM node_attrs ${this.whereClause(spec.filters)}`,
    );
    const idx = table.getChild('idx')!.toArray() as Int32Array;
    const c = table.getChild('c')!.toArray() as Float64Array;
    const s = table.getChild('s')!.toArray() as Float64Array;

    const filtered = spec.filters.length > 0;
    const neutral = neutralRgb();
    const style = new Uint32Array(this.nodeCount);
    style.fill(
      packStyle(
        neutral.r,
        neutral.g,
        neutral.b,
        filtered ? HIDDEN_SIZE_CODE : NEUTRAL_SIZE_CODE,
      ),
    );

    const categorical = colorCol?.kind === 'categorical';
    for (let i = 0; i < idx.length; i++) {
      const value = c[i];
      // list_position is 1-based, so slot 0 means "not one of the coloured
      // categories" and falls through to the neutral.
      const rgb =
        value < 0
          ? neutral
          : categorical
            ? categoryRgb(value - 1)
            : sequentialRgb(value);
      const size = s[i] < 0 ? NEUTRAL_SIZE_CODE : sizeCode(s[i]);
      style[idx[i]] = packStyle(rgb.r, rgb.g, rgb.b, size);
    }
    return { style, visible: idx.length };
  }

  /** Every attribute of one node, as displayed strings. */
  async values(node: number): Promise<Record<string, string>> {
    const table = await this.conn.query(
      `SELECT * EXCLUDE (idx) FROM node_attrs WHERE idx = ${node | 0} LIMIT 1`,
    );
    const row = table.get(0);
    if (!row) return {};
    const out: Record<string, string> = {};
    for (const col of this.cols) {
      const value = row[col.name];
      out[col.name] = value == null ? '—' : String(value);
    }
    return out;
  }

  /** Distribution of a numeric column, for the filter strip (§10). */
  async histogram(name: string): Promise<Histogram | null> {
    const col = this.column(name);
    if (!col || col.kind !== 'numeric') return null;
    const min = col.min ?? 0;
    const max = col.max ?? 0;
    const counts = new Array<number>(HISTOGRAM_BINS).fill(0);
    if (!(max > min)) return { min, max, counts };
    const width = (max - min) / HISTOGRAM_BINS;
    const table = await this.conn.query(
      `SELECT least(${HISTOGRAM_BINS - 1},
                    floor((CAST(${ident(name)} AS DOUBLE) - ${min}) / ${width})) AS bin,
              count(*) AS n
         FROM node_attrs WHERE ${ident(name)} IS NOT NULL
        GROUP BY 1 ORDER BY 1`,
    );
    for (const row of table) {
      const bin = Number(row?.bin ?? 0);
      if (bin >= 0 && bin < HISTOGRAM_BINS) counts[bin] = Number(row?.n ?? 0);
    }
    return { min, max, counts };
  }

  async close(): Promise<void> {
    try {
      await this.conn.query('DROP VIEW IF EXISTS node_attrs');
      await this.conn.query('DROP TABLE IF EXISTS attrs_raw');
      await this.conn.query('DROP TABLE IF EXISTS nodes');
      await this.db.dropFile(ATTRS_FILE).catch(() => {});
    } finally {
      await this.conn.close();
    }
  }
}
