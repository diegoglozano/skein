// Getting results out (§10 "Export: PNG, and coordinates as CSV").
//
// Both exports are built in the tab and handed to the browser as a blob URL,
// which is the only shape that keeps §7: a download that went through a server
// — even to format the file — would be the graph leaving the tab, and the
// no-network gate would be right to fail it.
//
// Coordinates are exported for *every* node, not for whatever the current
// filter, isolation or draw sample left on screen. The file is the layout, not
// the view: a coordinate dump that silently depended on the camera would be
// impossible to reproduce and useless to join back onto the edge list.

import { nodeId } from '../interact/search';

/** Rows per string chunk. Enough to amortise the join, small enough that the
 * intermediate strings stay in the nursery instead of becoming one 30 MB
 * string at the §9 top tier. */
const CHUNK_ROWS = 65_536;

/**
 * RFC 4180 quoting. Node ids come from the user's file and may contain
 * anything the parser accepted, including the delimiter — an unquoted dump
 * would produce a file this app's own scanner reads back as a different graph.
 */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * `id,x,y` for every node, as a Blob. Built in chunks rather than one string
 * so a million rows do not have to exist twice at once.
 */
export function positionsCsv(
  idBytes: Uint8Array,
  idOffsets: Uint32Array,
  positions: Float32Array,
): Blob {
  const n = positions.length >> 1;
  const parts: string[] = [];
  const rows: string[] = ['id,x,y'];
  for (let i = 0; i < n; i++) {
    rows.push(`${csvField(nodeId(idBytes, idOffsets, i))},${positions[2 * i]},${positions[2 * i + 1]}`);
    if (rows.length >= CHUNK_ROWS) {
      parts.push(`${rows.join('\n')}\n`);
      rows.length = 0;
    }
  }
  if (rows.length) parts.push(`${rows.join('\n')}\n`);
  return new Blob(parts, { type: 'text/csv' });
}

/**
 * Hand a blob to the browser as a download. The object URL is revoked on the
 * next task rather than immediately: Chromium starts the download from the
 * synthetic click asynchronously, and revoking in the same turn cancels it.
 */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** `medium.csv` + seed 42 → `medium-seed42`, the stem both exports share. */
export function exportStem(name: string, seed: number): string {
  const stem = name.replace(/\.[a-z0-9]+$/i, '') || 'graph';
  return `${stem}-seed${seed}`;
}
