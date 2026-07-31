// Node-id lookup over the flat dictionary (§10 "search by node ID").
//
// The dictionary is concatenated UTF-8 plus an offsets array (§4.2), so search
// is a byte scan — no string array to materialise, no index to keep in sync.
// At 1M nodes that is ~10 MB per query, a few ms, which is under a keystroke's
// budget; if it ever isn't, the fix is an n-gram index over the same bytes,
// not per-node JS strings.

const decoder = new TextDecoder();

/** Decode one node's id. Only ever called for ids we are about to display. */
export function nodeId(idBytes: Uint8Array, idOffsets: Uint32Array, node: number): string {
  return decoder.decode(idBytes.subarray(idOffsets[node], idOffsets[node + 1]));
}

/** ASCII lower-case; leaves non-ASCII bytes alone so UTF-8 stays intact. */
function lower(byte: number): number {
  return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
}

export interface SearchHit {
  node: number;
  id: string;
  /** True when the id equals or starts with the query. */
  prefix: boolean;
}

/**
 * Case-insensitive id search, prefix matches ranked above interior ones.
 * Returns at most `limit` hits; `truncated` means the result list was capped
 * or the scan stopped early, i.e. "these are the first N", not "these are all".
 */
export function searchNodes(
  idBytes: Uint8Array,
  idOffsets: Uint32Array,
  query: string,
  limit = 50,
): { hits: SearchHit[]; truncated: boolean } {
  const needle = new TextEncoder().encode(query);
  for (let i = 0; i < needle.length; i++) needle[i] = lower(needle[i]);
  if (needle.length === 0) return { hits: [], truncated: false };

  const nodeCount = idOffsets.length - 1;
  const prefixHits: number[] = [];
  const innerHits: number[] = [];
  let scanned = 0;

  for (let node = 0; node < nodeCount; node++) {
    scanned = node + 1;
    const start = idOffsets[node];
    const last = idOffsets[node + 1] - needle.length;
    for (let at = start; at <= last; at++) {
      let k = 0;
      while (k < needle.length && lower(idBytes[at + k]) === needle[k]) k++;
      if (k === needle.length) {
        (at === start ? prefixHits : innerHits).push(node);
        break;
      }
    }
    // Stop as soon as no further hit could reach the result list: a full
    // prefix bucket already fills it, and once both buckets hold `limit` the
    // ranking cannot change. Without this a query with few prefix hits — the
    // common case — scanned the whole dictionary on every keystroke.
    if (prefixHits.length >= limit || innerHits.length >= limit) break;
  }

  const ordered = prefixHits.concat(innerHits);
  const hits: SearchHit[] = [];
  for (let i = 0; i < ordered.length && hits.length < limit; i++) {
    const node = ordered[i];
    hits.push({ node, prefix: i < prefixHits.length, id: nodeId(idBytes, idOffsets, node) });
  }
  return {
    hits,
    // "These are the first N", not "these are all": true whenever the list was
    // cut or the scan stopped before the end of the dictionary.
    truncated: ordered.length > limit || scanned < nodeCount,
  };
}
