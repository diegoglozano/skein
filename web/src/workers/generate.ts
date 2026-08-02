// Synthetic sample graphs, generated in the tab (§7: no network, ever — a
// "download a sample dataset" button would be the one request this app must
// never make). The point is a device with no data on it: a phone, or a fresh
// laptop that has never run `npm run fixtures`.
//
// The algorithms here are a deliberate mirror of `bench/generate-fixtures.mjs`
// — same RNG, same preferential attachment, same planted partition, same id
// spelling — so a preset generated in the app is the *same graph* as the
// fixture of that name, edge for edge and row for row. That is not decoration:
// `tests/generate.spec.ts` ingests both and compares the layout's position
// hash, which is what stops the two copies drifting apart. Change one, change
// the other, and let that test judge it.
//
// (Why a copy at all: the fixture script is a plain Node script outside the
// web workspace, and reaching across into it would drag Vite's fs.allow and an
// untyped .mjs import into the build for forty lines of arithmetic.)

export interface SamplePreset {
  /** Matches the fixture name, so `small` here is `bench/fixtures/small.csv`. */
  key: string;
  nodes: number;
  edges: number;
  /** Set for a planted-partition graph; absent means preferential attachment. */
  communities?: number;
  pIntra?: number;
  /** What this size is *for* — shown next to the button. */
  blurb: string;
}

/** The seed `bench/generate-fixtures.mjs` uses; part of "same graph as the fixture". */
const FIXTURE_SEED = 0x5eed;

export const SAMPLE_PRESETS: SamplePreset[] = [
  {
    key: 'tiny',
    nodes: 10_000,
    edges: 50_000,
    blurb: 'quickest thing that is still a graph',
  },
  {
    key: 'clustered',
    nodes: 20_000,
    edges: 120_000,
    communities: 40,
    pIntra: 0.92,
    blurb: 'planted communities — the layout should separate them',
  },
  {
    key: 'small',
    nodes: 100_000,
    edges: 500_000,
    blurb: 'a phone-sized workout',
  },
  {
    key: 'medium',
    nodes: 1_000_000,
    edges: 10_000_000,
    blurb: 'desktop-class — ~150 MB of edges, minutes not seconds',
  },
];

export function samplePreset(key: string): SamplePreset {
  const preset = SAMPLE_PRESETS.find((p) => p.key === key);
  if (!preset) throw new Error(`unknown sample preset "${key}"`);
  return preset;
}

// xorshift64*, seeded — same preset must yield byte-identical output (§6, D2).
// BigInt is the slow part of generation (~1 µs an edge), and it stays: the
// fixture script's arithmetic *is* this, and a hand-rolled 32-bit-lane u64
// would be a second thing to keep bit-identical for a constant factor nobody
// waits on at the sizes a phone can render.
function makeRng(seed: number): () => number {
  let s = BigInt(seed);
  return () => {
    s ^= s << 13n;
    s ^= s >> 7n;
    s ^= s << 17n;
    s &= 0xffffffffffffffffn;
    return Number(((s * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn) >> 32n) / 0x100000000;
  };
}

export interface EdgeArrays {
  src: Uint32Array;
  dst: Uint32Array;
}

/** Called every few thousand edges so the worker can post progress. Purely
 * observational — it must not change the sequence of `rng()` calls. */
export type EdgeProgress = (edgesSoFar: number) => void;

const PROGRESS_EVERY = 1 << 16;

// Preferential attachment: each new node links to endpoints sampled from the
// existing edge array (degree-proportional), giving a scale-free degree
// distribution without an explicit degree index.
function generateScaleFree(
  nodes: number,
  edges: number,
  seed: number,
  onProgress?: EdgeProgress,
): EdgeArrays {
  const rng = makeRng(seed);
  const src = new Uint32Array(edges);
  const dst = new Uint32Array(edges);
  const perNode = Math.max(1, Math.floor(edges / nodes));
  let e = 0;
  let nextReport = PROGRESS_EVERY;
  // Seed clique so early sampling has endpoints to draw from.
  for (let i = 0; i < 3 && e < edges; i++) {
    src[e] = i;
    dst[e] = (i + 1) % 3;
    e++;
  }
  for (let v = 3; v < nodes && e < edges; v++) {
    const k = Math.min(perNode, edges - e);
    for (let j = 0; j < k; j++) {
      // 85% preferential, 15% uniform keeps a long tail without a star graph.
      const t =
        rng() < 0.85 ? (rng() < 0.5 ? src : dst)[Math.floor(rng() * e)] : Math.floor(rng() * v);
      src[e] = v;
      dst[e] = t === v ? (v > 0 ? v - 1 : 0) : t;
      e++;
    }
    if (e >= nextReport) {
      nextReport = e + PROGRESS_EVERY;
      onProgress?.(e);
    }
  }
  // Fill any remainder with degree-biased random pairs among all nodes.
  while (e < edges) {
    const a = (rng() < 0.5 ? src : dst)[Math.floor(rng() * e)];
    const b = Math.floor(rng() * nodes);
    src[e] = a;
    dst[e] = a === b ? (b + 1) % nodes : b;
    e++;
  }
  return { src, dst };
}

// Planted-partition graph: nodes split into equal communities; each edge is
// intra-community with probability pIntra, else uniform across the graph.
function generateClustered(
  nodes: number,
  edges: number,
  communities: number,
  pIntra: number,
  seed: number,
  onProgress?: EdgeProgress,
): EdgeArrays {
  const rng = makeRng(seed);
  const src = new Uint32Array(edges);
  const dst = new Uint32Array(edges);
  const size = Math.floor(nodes / communities);
  let nextReport = PROGRESS_EVERY;
  for (let e = 0; e < edges; e++) {
    const c = Math.floor(rng() * communities);
    const base = c * size;
    const a = base + Math.floor(rng() * size);
    let b;
    if (rng() < pIntra) {
      b = base + Math.floor(rng() * size);
    } else {
      b = Math.floor(rng() * nodes);
    }
    src[e] = a;
    dst[e] = a === b ? base + ((a - base + 1) % size) : b;
    if (e >= nextReport) {
      nextReport = e + PROGRESS_EVERY;
      onProgress?.(e);
    }
  }
  return { src, dst };
}

export function generateEdges(preset: SamplePreset, onProgress?: EdgeProgress): EdgeArrays {
  return preset.communities
    ? generateClustered(
        preset.nodes,
        preset.edges,
        preset.communities,
        preset.pIntra ?? 0.9,
        FIXTURE_SEED,
        onProgress,
      )
    : generateScaleFree(preset.nodes, preset.edges, FIXTURE_SEED, onProgress);
}

const HEADER = 'source,target';
/** Rows per encoded chunk; the fixture script writes the same run length. */
const ROWS_PER_CHUNK = 250_000;

function decimalDigits(value: number): number {
  // u32 range, so ten branches at most; called twice per edge in the sizing
  // pass, where allocating a string per endpoint would cost more than the CSV.
  let digits = 1;
  let v = value;
  while (v >= 10) {
    v = (v / 10) | 0;
    digits++;
  }
  return digits;
}

/**
 * Exact byte length of what `csvChunks` will yield. Worth a pass over the
 * arrays: it is the ingest progress bar's denominator and the graph's recorded
 * size, and both would otherwise be a guess for a file that never exists.
 */
export function csvByteLength({ src, dst }: EdgeArrays): number {
  let total = HEADER.length + 1;
  for (let i = 0; i < src.length; i++) {
    // "n<src>,n<dst>\n"
    total += 4 + decimalDigits(src[i]) + decimalDigits(dst[i]);
  }
  return total;
}

/**
 * The same CSV bytes the fixture file holds, in chunks, so the generated graph
 * goes through the real §4 ingest path — WASM parser, interner, CSR, OPFS —
 * rather than a shortcut that would leave that path untested on the device
 * doing the generating.
 */
export function* csvChunks({ src, dst }: EdgeArrays): Generator<Uint8Array> {
  const encoder = new TextEncoder();
  const lines: string[] = [HEADER];
  for (let i = 0; i < src.length; i++) {
    lines.push(`n${src[i]},n${dst[i]}`);
    if (lines.length >= ROWS_PER_CHUNK) {
      yield encoder.encode(lines.join('\n') + '\n');
      lines.length = 0;
    }
  }
  if (lines.length > 0) yield encoder.encode(lines.join('\n') + '\n');
}

/** Stable per preset, so regenerating overwrites instead of piling up copies. */
export function sampleGraphId(preset: SamplePreset): string {
  return `sample-${preset.key}`;
}

export function sampleGraphName(preset: SamplePreset): string {
  return `${preset.key} (generated)`;
}
