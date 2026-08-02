#!/usr/bin/env node
// Deterministic synthetic fixture generator (REQUIREMENTS.md §14: never commit
// large fixtures — regenerate). Produces scale-free graphs via preferential
// attachment, written as:
//   - {name}.csv        "source,target" with string ids, for ingest tests
//   - {name}.bin        little-endian u32 pairs, for the render/layout spike
//   - {name}-nodes.csv  node attributes, the D4 second file (M4)
//
// Usage: node bench/generate-fixtures.mjs [preset ...]
// Presets: tiny (10k/50k), small (100k/500k), medium (1M/10M), huge (10M/100M)
//
// `web/src/workers/generate.ts` is a copy of the RNG and both graph generators
// below, so the app can make the same graphs on a device that has no files on
// it (DECISIONS.md D17). Change anything here that affects the *output* — the
// RNG, the attachment rule, the id spelling, the row order — and change it
// there too; `tests/generate.spec.ts` fails when they disagree.

import { createWriteStream, mkdirSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const PRESETS = {
  tiny: { nodes: 10_000, edges: 50_000 },
  small: { nodes: 100_000, edges: 500_000 },
  medium: { nodes: 1_000_000, edges: 10_000_000 },
  // The scale skein-native exists for (DECISIONS.md D15): past the browser's
  // 4 GB wasm cap, so this one is native-only. ~1.6 GB of CSV — never committed.
  huge: { nodes: 10_000_000, edges: 100_000_000 },
  // Planted communities: layout quality is judged visually on this one —
  // a correct force layout must separate the clusters (M3).
  clustered: { nodes: 20_000, edges: 120_000, communities: 40, pIntra: 0.92 },
};

// xorshift64*, seeded — same preset must yield byte-identical files (§6).
function makeRng(seed) {
  let s = BigInt(seed);
  return () => {
    s ^= s << 13n;
    s ^= s >> 7n;
    s ^= s << 17n;
    s &= 0xffffffffffffffffn;
    return Number((s * 0x2545f4914f6cdd1dn & 0xffffffffffffffffn) >> 32n) / 0x100000000;
  };
}

// Preferential attachment: each new node links to endpoints sampled from the
// existing edge array (degree-proportional), giving a scale-free degree
// distribution without an explicit degree index.
function generate(nodes, edges, seed = 0x5eed) {
  const rng = makeRng(seed);
  const src = new Uint32Array(edges);
  const dst = new Uint32Array(edges);
  const perNode = Math.max(1, Math.floor(edges / nodes));
  let e = 0;
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
        rng() < 0.85
          ? (rng() < 0.5 ? src : dst)[Math.floor(rng() * e)]
          : Math.floor(rng() * v);
      src[e] = v;
      dst[e] = t === v ? (v > 0 ? v - 1 : 0) : t;
      e++;
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

async function writeAll(stream, chunks) {
  for (const chunk of chunks) {
    if (!stream.write(chunk)) await once(stream, 'drain');
  }
}

// Planted-partition graph: nodes split into equal communities; each edge is
// intra-community with probability pIntra, else uniform across the graph.
function generateClustered(nodes, edges, communities, pIntra, seed = 0x5eed) {
  const rng = makeRng(seed);
  const src = new Uint32Array(edges);
  const dst = new Uint32Array(edges);
  const size = Math.floor(nodes / communities);
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
  }
  return { src, dst };
}

// Node attributes — the second file of D4's two-file ingest, joined on the node
// id. Three columns, one of each shape the UI has to handle: a wide
// categorical, a continuous numeric, and a small categorical.
//
// For the clustered preset `community` is the *planted* community, which makes
// colour-by-community the visual check on both layout and the join: the colours
// must land on the blobs the force sim separated.
//
// The last rows are ids that appear in no edge, so the unmatched-key report has
// something to report on every fixture.
const GHOST_KEYS = 10;
const KINDS = ['hub', 'bridge', 'leaf'];

async function writeNodeAttributes(name, { nodes, communities }, seed = 0xa771b) {
  const rng = makeRng(seed);
  const groups = communities ?? 12;
  const size = Math.max(1, Math.floor(nodes / groups));
  const csv = createWriteStream(path.join(OUT_DIR, `${name}-nodes.csv`));
  const CHUNK = 250_000;
  const chunks = [];
  let buf = ['id,community,score,kind'];
  for (let i = 0; i < nodes; i++) {
    // Planted communities are contiguous id ranges (see generateClustered), so
    // the same arithmetic recovers them exactly.
    const community = Math.min(groups - 1, Math.floor(i / size));
    buf.push(`n${i},c${community},${rng().toFixed(4)},${KINDS[Math.floor(rng() * KINDS.length)]}`);
    if (buf.length >= CHUNK) {
      chunks.push(buf.join('\n') + '\n');
      buf = [];
    }
  }
  for (let i = 0; i < GHOST_KEYS; i++) {
    buf.push(`ghost${i},c0,${rng().toFixed(4)},${KINDS[0]}`);
  }
  chunks.push(buf.join('\n') + '\n');
  await writeAll(csv, chunks);
  csv.end();
  await once(csv, 'close');
}

async function writeFixture(name, { nodes, edges, communities, pIntra }) {
  mkdirSync(OUT_DIR, { recursive: true });
  const t0 = performance.now();
  const { src, dst } = communities
    ? generateClustered(nodes, edges, communities, pIntra)
    : generate(nodes, edges);

  // Binary: u32 pairs, header [magic, nodes, edges, reserved].
  const bin = createWriteStream(path.join(OUT_DIR, `${name}.bin`));
  const header = new Uint32Array([0x534b4e31 /* "SKN1" */, nodes, edges, 0]);
  const interleaved = new Uint32Array(edges * 2);
  for (let i = 0; i < edges; i++) {
    interleaved[2 * i] = src[i];
    interleaved[2 * i + 1] = dst[i];
  }
  await writeAll(bin, [Buffer.from(header.buffer), Buffer.from(interleaved.buffer)]);
  bin.end();
  await once(bin, 'close');

  // CSV with string ids, chunked so the 10M-edge file never materialises.
  const csv = createWriteStream(path.join(OUT_DIR, `${name}.csv`));
  const CHUNK = 250_000;
  const chunks = [];
  let buf = ['source,target'];
  for (let i = 0; i < edges; i++) {
    buf.push(`n${src[i]},n${dst[i]}`);
    if (buf.length >= CHUNK) {
      chunks.push(buf.join('\n') + '\n');
      buf = [];
    }
  }
  chunks.push(buf.join('\n') + (buf.length ? '\n' : ''));
  await writeAll(csv, chunks);
  csv.end();
  await once(csv, 'close');

  await writeNodeAttributes(name, { nodes, communities });

  console.log(`${name}: ${nodes} nodes, ${edges} edges in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : ['tiny', 'small'];
for (const name of names) {
  if (!PRESETS[name]) {
    console.error(`unknown preset "${name}" — options: ${Object.keys(PRESETS).join(', ')}`);
    process.exit(1);
  }
  await writeFixture(name, PRESETS[name]);
}
