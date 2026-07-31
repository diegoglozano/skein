# skein — Requirements

> A fully client-side, open source viewer for large network graphs.
> Upload an edge list, get an interactive layout. Your data never leaves the tab.

This document is the working brief for implementation. It is written to be read
cold at the start of a session: read it top to bottom before writing code.

---

## 1. Problem

Exploring a large network graph today means one of:

- **Desktop tools** (Gephi, Cytoscape) — good algorithms, poor ergonomics, no sharing,
  and they choke well before 10M edges.
- **Hosted web tools** (Cosmograph, Graphistry) — excellent UX, but the app layer is
  closed source. Cosmograph's app is the closest existing thing to skein and does keep
  data local; it is simply not something you can read, fork, audit, or self-host.
- **Libraries** (cosmos.gl, sigma.js, G6) — you have to build the whole application
  around them: ingest, indexing, filtering, persistence, UI.

There is no open source, self-hostable, statically deployable application that lets a
user drop a large graph file into a browser and explore it, with a verifiable guarantee
that nothing is transmitted.

**skein is that application.**

## 2. Goals

1. Open an edge list (CSV / Parquet / Arrow) of up to **1M nodes and 10M edges** and
   produce a usable force-directed layout.
2. Ingest to first render in **under 60 seconds** on a mid-range 2023 laptop.
3. Sustain **≥ 30 fps** during pan/zoom at that scale.
4. Operate with **zero network requests after initial page load**. This is an
   invariant, not a preference — see §7.
5. Deploy as **static files**. No backend, no build server, no account.
6. Persist parsed graphs so reopening is near-instant.

## 3. Non-goals (v1)

- Graph editing. skein is a viewer.
- Server-side anything.
- Mobile. Desktop Chromium/Firefox/Safari only; degrade gracefully, don't optimise.
- 3D layouts.
- Collaboration, comments, sharing links.
- A published JS library API. Application first; extract a library later if it earns it.
- GraphML / GEXF ingest. XML streaming is a tarpit — defer.

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Main thread — UI (React), render loop, camera              │
└───────────────┬─────────────────────────────────────────────┘
                │ postMessage + transferables / SharedArrayBuffer
┌───────────────▼─────────────────────────────────────────────┐
│  Ingest Worker                                              │
│    stream file → parse → intern IDs → build CSR → OPFS      │
├─────────────────────────────────────────────────────────────┤
│  Analytics Worker                                           │
│    DuckDB-WASM: attribute tables, filters, histograms       │
├─────────────────────────────────────────────────────────────┤
│  Layout                                                     │
│    coarsen (WASM) → GPU force sim (WebGPU) → refine down    │
└─────────────────────────────────────────────────────────────┘
```

### 4.1 Pipeline stages

| Stage | Where | Notes |
|---|---|---|
| Read | Worker | `File.stream()`, chunked. Never `text()` the whole file. |
| Parse | WASM | CSV via a streaming SIMD parser; Parquet/Arrow via DuckDB-WASM. |
| Intern | WASM | String node IDs → `u32`. Open-addressing hash map. **This is the hot spot.** |
| CSR build | WASM | Counting sort by source. Two passes: degree histogram, then fill. |
| Persist | OPFS | Write CSR + id dictionary + attributes as binary. |
| Coarsen | WASM | Label propagation → hierarchy of levels. |
| Layout | GPU | Force sim on coarsest level, prolongate down, refine. |
| Render | GPU | Instanced quads for nodes, line segments for edges. |

### 4.2 Core data structures

Everything is struct-of-arrays in flat typed arrays. **No JS objects per node or edge**
anywhere in the hot path — this is the single most important rule in the codebase.

```
CSR:
  offsets:  Uint32Array(n + 1)
  targets:  Uint32Array(m)
  weights:  Float32Array(m)     // optional

Positions:
  xy:       Float32Array(2n)

Dictionary:
  ids:      Uint8Array          // concatenated UTF-8
  idOffsets: Uint32Array(n + 1)
```

At 10M edges CSR is ~80 MB. At 100M edges it is ~800 MB — which is the point where
OPFS streaming stops being optional.

## 5. Tech stack

| Concern | Choice | Rationale |
|---|---|---|
| Core compute | **Rust → WASM** (`wasm-bindgen`, SIMD on) | Interning, CSR, coarsening. |
| Attributes / filters | **DuckDB-WASM** | Free SQL, histograms, joins on metadata. Don't hand-roll this. |
| Rendering | **WebGPU**, WebGL2 fallback | Compute shaders make the force sim tractable. |
| Renderer library | Evaluate **cosmos.gl** before writing one | Apache-2.0, OpenJS-governed, battle-tested. Only write our own if the out-of-core requirement forces it. |
| UI | React + Vite + TypeScript | |
| Persistence | **OPFS** | Synchronous access handles, Workers only. |
| Hosting | Cloudflare Pages / Netlify | Must be able to set COOP/COEP headers — see §8. |

Decide the cosmos.gl question **first**, with a spike. It determines whether this is a
3-month project or a 12-month one.

## 6. Layout algorithm

Multilevel, because single-level force simulation does not converge at this scale.

1. **Coarsen.** Label propagation (cheap, parallel) to build a hierarchy. Target ~10x
   reduction per level, stop at ~10k nodes.
2. **Lay out the coarsest level** with a full force sim until stable.
3. **Prolongate.** Place each fine node at its supernode's position plus jitter.
4. **Refine.** Short force sim at each level, decreasing iteration count as levels grow.

Forces: spring attraction along edges, repulsion approximated by a **uniform grid**
(not a quadtree — grids map far better onto GPU compute and avoid the tree-traversal
divergence that hurts cosmos.gl's quadtree path on some hardware).

**Determinism is a requirement.** Seed all RNG explicitly and expose the seed in the UI.
The same file must produce the same picture twice, or the tool is useless for reports.

## 7. Privacy invariants

These are the product. Treat any violation as a P0 bug.

- **No network requests after load.** Enforce with a CSP meta tag: `connect-src 'self'`
  (same-origin only — required for streaming WASM instantiation and lazy-loaded
  same-origin bundles; see docs/DECISIONS.md D1). The Playwright network test is the
  authoritative check that nothing leaves the origin.
- **Everything self-hosted.** No CDN, no Google Fonts, no analytics, no error reporting,
  no telemetry, not even opt-in in v1.
- **No source maps pointing off-origin.**
- **Automated test:** a Playwright run that loads a fixture graph, exercises the full
  pipeline, and asserts the network log contains zero requests beyond the initial
  document and its same-origin assets. This test gates merges to `main`.
- **Visible affordance.** A badge in the UI stating no data leaves the browser, linking
  to instructions for verifying it in devtools.

Service workers used for cross-origin isolation (§8) must be audited — they intercept
every request and are the most likely place for this guarantee to quietly break.

## 8. Browser constraints

- **Cross-origin isolation.** `SharedArrayBuffer` requires COOP/COEP headers. Without
  them, no parallel layout across Workers. GitHub Pages cannot set headers; either host
  somewhere that can, or use a `coi-serviceworker` shim (and audit it — see §7).
- **Memory.** WASM linear memory caps at 4 GB without memory64. Budget accordingly and
  fail loudly with a clear message rather than crashing the tab.
- **WebGPU availability.** Broadly shipped on desktop, but the WebGL2 fallback is not
  optional. Detect at startup and tell the user which path they're on.
- **GPU variance is real.** Prior art documents concrete failures: cosmos.gl does not run
  on Android devices lacking `OES_texture_float`, and its quadtree path breaks on some
  Nvidia/Windows configurations unless ANGLE is disabled. Maintain a compatibility matrix
  and a software-ish fallback for small graphs.
- **OPFS quota.** Request persistent storage; handle eviction and quota-exceeded.

## 9. Performance targets

| Graph | Ingest | Layout | Render |
|---|---|---|---|
| 100k nodes / 500k edges | < 3 s | < 5 s | 60 fps |
| 1M nodes / 10M edges | < 60 s | < 45 s | ≥ 30 fps |
| 5M nodes / 50M edges | best effort | best effort | ≥ 20 fps, coarsened |

Benchmark on a mid-range 2023 laptop, not a workstation. Track these in CI from the
first milestone — performance regressions are invisible until they're catastrophic.

## 10. UI surface (v1)

- Drop zone / file picker. Format sniffing, column mapping dialog (source, target,
  optional weight and metadata join key).
- Progress with real stage names, not a spinner. Ingest is long enough that silence
  reads as a hang.
- Canvas: pan, zoom, box select, node hover with attribute card.
- Sidebar: search by node ID, degree histogram, attribute filters (backed by DuckDB),
  layout controls (seed, iterations, repulsion strength), colour/size by column.
- Neighbourhood expansion: select a node, expand k hops, isolate subgraph.
- Recent files, loaded from OPFS.
- Export: PNG, and coordinates as CSV/Parquet.

## 11. Milestones

**M0 — Spike (1 week).** Answer the cosmos.gl question. Load a 1M-edge file with it,
measure, decide build-vs-wrap. Nothing else matters until this is settled.

**M1 — Ingest.** Rust/WASM pipeline: streaming CSV → interning → CSR → OPFS. CLI-ish
test harness, no UI. Benchmarks in CI.

**M2 — Render.** Static layout (precomputed coordinates) rendered at 1M nodes with pan
and zoom. Proves the render path independently of layout.

**M3 — Layout.** Multilevel coarsening plus GPU force sim. Deterministic.

**M4 — Explore.** DuckDB-WASM attributes, filters, search, hover, selection.

**M5 — Ship.** Privacy test suite green, compatibility matrix, docs, static deploy.

## 12. Repo layout

```
skein/
├── crates/
│   ├── skein-core/       # CSR, interning, coarsening
│   └── skein-wasm/       # wasm-bindgen boundary
├── web/
│   ├── src/
│   │   ├── workers/      # ingest, analytics
│   │   ├── render/
│   │   ├── layout/
│   │   └── ui/
│   └── public/
├── bench/                # fixture graphs + perf harness
├── tests/                # Playwright, incl. the no-network test
└── REQUIREMENTS.md
```

License: **Apache-2.0** (matches cosmos.gl, permissive enough for corporate adoption).

## 13. Open questions

- Wrap cosmos.gl or write the renderer? → M0 decides. Spike thresholds are recorded in
  docs/DECISIONS.md D3.
- Is DuckDB-WASM's bundle size (~30 MB wasm) acceptable for a tool that must work
  offline after first load? Measure; consider lazy-loading it only when metadata is
  attached.
- Coarsening: label propagation is fast but low quality. Is Leiden worth the complexity
  in v1, or is it an M3+ refinement?
- Edge rendering above ~20M edges: bundle, sample, or draw a density field? Sampling is
  simplest and probably right for v1.
- Do we need `memory64` for the 50M-edge tier, and is it available enough to rely on?
- **Deferred: a Tauri desktop app.** Wanted for the OS-native file picker, a real
  app icon, and a ~10 MB artifact instead of the ~12 MB binary that embeds the
  bundle. Blocked on WebGPU in WebKitGTK, which is unimplemented — a Tauri build
  today would silently drop Linux users to the WebGL2 renderer and the CPU sim
  (docs/DECISIONS.md D10). Revisit when WebKitGTK ships it; until then `skein`
  the binary (D10) covers the same want without the regression.

## 14. Working notes for implementation

- Build the benchmark harness **before** the optimisations. Every performance claim in
  this document should be a number in CI.
- Fixture graphs: generate synthetic (LFR benchmark, scale-free) plus one real public
  dataset for sanity. Do not commit large fixtures — generate or fetch in a script.
- The three things most likely to go wrong, in order: ID interning throughput, OPFS
  write performance, and force-sim convergence at coarse levels. Front-load all three.
- When in doubt about a data structure, choose the one that is a flat typed array.
