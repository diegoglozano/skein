#!/usr/bin/env node
// Deterministic synthetic fixture generator (REQUIREMENTS.md §14: never commit
// large fixtures — regenerate). Produces scale-free graphs via preferential
// attachment, written as:
//   - {name}.csv   "source,target" with string ids, for ingest tests
//   - {name}.bin   little-endian u32 pairs, for the render/layout spike
//
// Usage: node bench/generate-fixtures.mjs [preset ...]
// Presets: tiny (10k/50k), small (100k/500k), medium (1M/10M)

import { createWriteStream, mkdirSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const PRESETS = {
  tiny: { nodes: 10_000, edges: 50_000 },
  small: { nodes: 100_000, edges: 500_000 },
  medium: { nodes: 1_000_000, edges: 10_000_000 },
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

async function writeFixture(name, { nodes, edges }) {
  mkdirSync(OUT_DIR, { recursive: true });
  const t0 = performance.now();
  const { src, dst } = generate(nodes, edges);

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
