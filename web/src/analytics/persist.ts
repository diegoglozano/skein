// Reading the persisted attributes file back, from the main thread.
//
// Writing it stays in the ingest worker (`workers/opfs.ts`, `attrs.csv` under
// the graph's directory) because that is where the sync access handles are.
// Reading does not need one: `getFile()` is available on the main thread and
// hands back a `File`, which is exactly what DuckDB wants to register — so the
// bytes never pass through a postMessage or a second copy.

/** Must match `ATTRS_FILE` in `workers/opfs.ts`. */
const ATTRS_NAME = 'attrs.csv';

export async function readAttributesFile(id: string): Promise<File | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('graphs')).getDirectoryHandle(id);
    return await (await dir.getFileHandle(ATTRS_NAME)).getFile();
  } catch {
    // No attributes attached to this graph, or storage was evicted.
    return null;
  }
}
