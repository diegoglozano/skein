// DuckDB-WASM lifecycle (REQUIREMENTS.md §5, DECISIONS.md D4/D14).
//
// Two things about this file are load-bearing for §7:
//
//  1. The bundle URLs are ours. duckdb-wasm's own `getJsDelivrBundles()` — the
//     path every tutorial uses — resolves the worker and the 34 MB wasm from a
//     CDN, which is a privacy violation that would look like a working app.
//     Both are imported through Vite so they are emitted as same-origin assets
//     and the CSP's `connect-src 'self'` would block anything else.
//  2. The import of duckdb itself is dynamic, so a session that never attaches
//     attributes never fetches any of it. That is what makes the payload
//     affordable (D14).
//
// We ship one bundle, `eh` (WebAssembly exception handling, single-threaded),
// rather than selecting at runtime: `mvp` exists for browsers without EH, which
// no browser that has WebGPU or WebGL2 plus OPFS is, and `coi` buys threads for
// a second 34 MB. Shipping one instead of three is 68 MB of dist we don't
// carry.

import type { AsyncDuckDB } from '@duckdb/duckdb-wasm';
import ehWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

let instance: Promise<AsyncDuckDB> | null = null;

/**
 * The process-wide database, started on first use. DuckDB already runs its work
 * in a Worker it owns, so this is deliberately *not* wrapped in another one —
 * that would nest workers to move the same work off the same thread twice.
 */
export function openDatabase(): Promise<AsyncDuckDB> {
  instance ??= (async () => {
    const duckdb = await import('@duckdb/duckdb-wasm');
    const worker = new Worker(ehWorkerUrl);
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await db.instantiate(ehWasmUrl);
    // Counts and sums come back as BigInt otherwise, which then has to be
    // unwrapped at every call site.
    await db.open({ query: { castBigIntToDouble: true } });
    return db;
  })().catch((err) => {
    // Don't cache a failed start: a retry should be able to succeed.
    instance = null;
    throw err;
  });
  return instance;
}

/**
 * Expose a file to DuckDB *by handle*, so `read_csv_auto` pulls ranges out of
 * it as it needs them. Reading the whole attributes file into memory first
 * would double-count a large one against the §8 memory budget for nothing.
 *
 * The dynamic import here is the same already-resolved module `openDatabase`
 * loaded — it is repeated rather than threaded through because
 * `DuckDBDataProtocol` is a runtime enum, not a type.
 */
export async function registerFile(db: AsyncDuckDB, name: string, file: Blob): Promise<void> {
  const duckdb = await import('@duckdb/duckdb-wasm');
  await db.registerFileHandle(name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
}
