// Synthetic sample graphs, generated in the tab (§7: no network, ever — a
// "download a sample dataset" button would be the one request this app must
// never make). The point is a device with no data on it: a phone, or a fresh
// laptop that has never run `npm run fixtures`.
//
// The size is the user's: the drop zone asks for a node count and an edge
// count, and this synthesizes a scale-free graph of exactly that shape. The
// algorithm is a deliberate mirror of `bench/generate-fixtures.mjs` — same RNG,
// same preferential attachment, same `n<i>` id spelling — so asking for a
// fixture's numbers (10,000 / 50,000) yields the *same graph* as
// `bench/fixtures/tiny.csv`, edge for edge and row for row. That is not
// decoration: `tests/generate.spec.ts` ingests both and compares the layout's
// position hash, which is what stops the two copies drifting apart. Change one,
// change the other, and let that test judge it.
//
// (Why a copy at all: the fixture script is a plain Node script outside the
// web workspace, and reaching across into it would drag Vite's fs.allow and an
// untyped .mjs import into the build for forty lines of arithmetic.)

/** A requested graph size. Nothing else is asked for — the shape is the
 * fixture script's preferential attachment, which is the one generator whose
 * output we keep bit-identical across the two copies. */
export interface SampleSpec {
  nodes: number;
  edges: number;
}

/** The seed `bench/generate-fixtures.mjs` uses; part of "same graph as the fixture". */
const FIXTURE_SEED = 0x5eed;

/**
 * Bounds on what may be typed into the two fields. The ceilings are the sizes
 * this path has actually been run at: `medium` (1M/10M) was the largest preset
 * before the fields replaced them, and generation allocates 8 bytes an edge
 * plus the CSV it streams, so an unbounded field is an out-of-memory tab
 * rather than a long wait.
 */
export const SAMPLE_LIMITS = {
  minNodes: 2,
  maxNodes: 5_000_000,
  minEdges: 1,
  maxEdges: 20_000_000,
} as const;

/** What the fields start at — the old `tiny` preset, and the fixture the
 * generator's bit-identity test uses. */
export const DEFAULT_SAMPLE: SampleSpec = { nodes: 10_000, edges: 50_000 };

/**
 * Why the requested size cannot be generated, or null if it can. The
 * edges ≥ nodes rule is not arbitrary: node ids exist only where an edge
 * mentions them, so a graph with fewer edges than nodes silently comes back
 * smaller than the number that was typed.
 */
export function sampleSpecError(spec: SampleSpec): string | null {
  const { nodes, edges } = spec;
  const whole = (n: number) => Number.isInteger(n) && n >= 0;
  if (!whole(nodes) || !whole(edges)) return 'node and edge counts must be whole numbers';
  if (nodes < SAMPLE_LIMITS.minNodes || nodes > SAMPLE_LIMITS.maxNodes) {
    return `node count must be between ${grouped(SAMPLE_LIMITS.minNodes)} and ${grouped(SAMPLE_LIMITS.maxNodes)}`;
  }
  if (edges < SAMPLE_LIMITS.minEdges || edges > SAMPLE_LIMITS.maxEdges) {
    return `edge count must be between ${grouped(SAMPLE_LIMITS.minEdges)} and ${grouped(SAMPLE_LIMITS.maxEdges)}`;
  }
  if (edges < nodes) {
    return 'every node needs at least one edge — ask for at least as many edges as nodes';
  }
  return null;
}

/** Thousands separators without `toLocaleString`: this string ends up in a
 * graph *name*, which is persisted, and a name that depends on the browser's
 * locale would make the same request two different graphs. */
export function grouped(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// xorshift64*, seeded — the same size must yield byte-identical output (§6, D2).
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

export function generateEdges(spec: SampleSpec, onProgress?: EdgeProgress): EdgeArrays {
  // The UI blocks these, but the worker is a message endpoint and the message
  // carries two numbers — a bad pair must fail here rather than allocate.
  const error = sampleSpecError(spec);
  if (error) throw new Error(error);
  return generateScaleFree(spec.nodes, spec.edges, FIXTURE_SEED, onProgress);
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

/** Stable per size, so regenerating the same numbers overwrites instead of
 * piling up copies — while two different sizes stay two graphs. */
export function sampleGraphId(spec: SampleSpec): string {
  return `sample-${spec.nodes}x${spec.edges}`;
}

export function sampleGraphName(spec: SampleSpec): string {
  return `${grouped(spec.nodes)}×${grouped(spec.edges)} (generated)`;
}
