# workers/

`ingest.ts` streams a `File` through the WASM parser in chunks and writes CSR +
dictionary to OPFS (M1). `opfs.ts` owns the on-disk formats and the
recent-graphs listing; `protocol.ts` is the main-thread ↔ worker message
contract, including the fixed ingest column mapping.

`generate.ts` synthesizes a sample graph for a device that has no data on it,
and hands it to the same ingest routine as a dropped file — CSV bytes in, no
shortcut past the parser (D17). It is a copy of `bench/generate-fixtures.mjs`
and must stay one; `tests/generate.spec.ts` is what enforces that.

The worker also serves the graph queries that need the whole CSR: `load` ships
render buffers plus the dictionary and a degree column, and `neighbors` answers
the M4 selection query. Both call into `skein-core` — algorithms do not live
here, only buffer movement (DECISIONS.md D12). The CSR is cached per graph, as
a promise, because OPFS grants one sync access handle per file.

Errors carry the `request` that failed: the layout waiter and the ingest UI
share the `error` message, and an untagged failure from a click-rate query used
to abort an in-flight layout.

Cursor-rate work (hit-testing, id search) is deliberately *not* here — it runs
on the main thread in `web/src/interact/`, since the WASM instance lives in
this worker and a `postMessage` per `pointermove` would lag the cursor (D12).

The analytics worker (DuckDB-WASM attributes and filters — the unfinished half
of M4) lands here.
