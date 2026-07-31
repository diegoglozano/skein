// OPFS persistence for parsed graphs (REQUIREMENTS.md §4.1 "Persist" stage).
// Worker-only: synchronous access handles don't exist on the main thread.
//
// Layout: graphs/<id>/{manifest.json, csr.bin, dict.bin}
//
//   csr.bin:  header [u32 'SKC1', nodeCount, edgeCount, flags(bit0 = weighted)]
//             offsets  Uint32Array(nodeCount + 1)
//             targets  Uint32Array(edgeCount)
//             weights  Float32Array(edgeCount)   -- iff weighted
//   dict.bin: header [u32 'SKD1', nodeCount, idBytesLen, 0]
//             idOffsets Uint32Array(nodeCount + 1)
//             idBytes   Uint8Array(idBytesLen)
//
// All little-endian, all flat typed arrays (§4.2) — reload is a header check
// plus bulk reads, no parsing.

import type { GraphSummary } from './protocol';

export const CSR_MAGIC = 0x534b_4331; // "SKC1"
export const DICT_MAGIC = 0x534b_4431; // "SKD1"

export interface GraphBuffers {
  offsets: Uint32Array;
  targets: Uint32Array;
  weights?: Float32Array;
  idBytes: Uint8Array;
  idOffsets: Uint32Array;
}

async function graphsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('graphs', { create: true });
}

/** Deterministic per-file id so re-importing the same file overwrites. */
export function graphId(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`.replace(/[^\w.-]+/g, '_');
}

async function writeFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  parts: (ArrayBufferView | ArrayBuffer)[],
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const access = await handle.createSyncAccessHandle();
  try {
    access.truncate(0);
    let at = 0;
    for (const part of parts) {
      access.write(part, { at });
      at += part.byteLength;
    }
    access.flush();
  } finally {
    access.close();
  }
}

export async function persistGraphBuffers(
  id: string,
  buffers: GraphBuffers,
  nodeCount: number,
  edgeCount: number,
): Promise<void> {
  const dir = await (await graphsDir()).getDirectoryHandle(id, { create: true });
  const { offsets, targets, weights, idBytes, idOffsets } = buffers;

  const csrHeader = new Uint32Array([CSR_MAGIC, nodeCount, edgeCount, weights ? 1 : 0]);
  const csrParts: (ArrayBufferView | ArrayBuffer)[] = [csrHeader, offsets, targets];
  if (weights) csrParts.push(weights);
  await writeFile(dir, 'csr.bin', csrParts);

  const dictHeader = new Uint32Array([DICT_MAGIC, nodeCount, idBytes.byteLength, 0]);
  await writeFile(dir, 'dict.bin', [dictHeader, idOffsets, idBytes]);
}

/** Written last: a graph without a manifest is treated as partial and ignored. */
export async function writeManifest(id: string, summary: GraphSummary): Promise<void> {
  const dir = await (await graphsDir()).getDirectoryHandle(id, { create: true });
  await writeFile(dir, 'manifest.json', [new TextEncoder().encode(JSON.stringify(summary))]);
}

export async function listGraphs(): Promise<GraphSummary[]> {
  const dir = await graphsDir();
  const graphs: GraphSummary[] = [];
  for await (const name of dir.keys()) {
    try {
      const entry = await dir.getDirectoryHandle(name);
      const manifest = await entry.getFileHandle('manifest.json');
      const text = await (await manifest.getFile()).text();
      graphs.push(JSON.parse(text) as GraphSummary);
    } catch {
      // Partially-written or foreign entry; skip rather than fail the list.
    }
  }
  graphs.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  return graphs;
}

/**
 * Re-open a persisted graph and check headers and sizes against its manifest.
 * Full buffer loading for render comes with M2; this proves the reload path.
 */
export async function verifyGraph(id: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const dir = await (await graphsDir()).getDirectoryHandle(id);
    const manifest = JSON.parse(
      await (await (await dir.getFileHandle('manifest.json')).getFile()).text(),
    ) as GraphSummary;

    const csrHandle = await (await dir.getFileHandle('csr.bin')).createSyncAccessHandle();
    const dictHandle = await (await dir.getFileHandle('dict.bin')).createSyncAccessHandle();
    try {
      const csrHeader = new Uint32Array(4);
      csrHandle.read(csrHeader, { at: 0 });
      const dictHeader = new Uint32Array(4);
      dictHandle.read(dictHeader, { at: 0 });

      const [csrMagic, n, m, flags] = csrHeader;
      const weighted = (flags & 1) === 1;
      const expectCsr = 16 + 4 * (n + 1) + 4 * m + (weighted ? 4 * m : 0);
      const expectDict = 16 + 4 * (n + 1) + dictHeader[2];

      if (csrMagic !== CSR_MAGIC || dictHeader[0] !== DICT_MAGIC)
        return { ok: false, detail: 'bad magic' };
      if (n !== manifest.nodeCount || m !== manifest.edgeCount)
        return { ok: false, detail: 'counts disagree with manifest' };
      if (csrHandle.getSize() !== expectCsr || dictHandle.getSize() !== expectDict)
        return { ok: false, detail: 'file size mismatch' };
      return {
        ok: true,
        detail: `${n.toLocaleString()} nodes / ${m.toLocaleString()} edges intact on disk`,
      };
    } finally {
      csrHandle.close();
      dictHandle.close();
    }
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}
