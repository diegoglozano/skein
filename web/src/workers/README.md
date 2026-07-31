# workers/

`ingest.ts` streams a `File` through the WASM parser in chunks and writes CSR +
dictionary to OPFS (M1). `opfs.ts` owns the on-disk formats and the
recent-graphs listing; `protocol.ts` is the main-thread ↔ worker message
contract, including the fixed ingest column mapping.

The analytics worker (M4: DuckDB-WASM attributes, filters, search) lands here
too.
