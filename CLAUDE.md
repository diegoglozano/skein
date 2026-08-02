# CLAUDE.md

Orientation for a fresh session. Read REQUIREMENTS.md top to bottom before
writing code — it is the brief. docs/DECISIONS.md records resolved design
questions (D1–D12); don't relitigate them without new evidence.

## Roadmap and current status

The roadmap is REQUIREMENTS.md §11 (M0–M5). Status as of 2026-07-31:

- **Done — scaffold (pre-M0):** repo layout per §12; `skein-core` interner +
  CSR builder (tested, benchmarked: ~3.1M interns/s, 10M-edge CSR in ~0.2s on
  a dev container); `skein-wasm` boundary compiles for wasm32; web shell with
  privacy badge + build-time CSP; deterministic fixture generator; Playwright
  no-network privacy gate (passing); CI (fmt/clippy/tests/wasm32/bench-ratio +
  build/privacy/app-suite).
- **M0 — done, verdict: build (DECISIONS.md D7).** The 1M/10M spike ran
  2026-07-31 on the reference laptop (M3 MacBook Air, real GPU, headed
  Chromium) and failed all three D3 thresholds: 64 sim ticks in 120 s /
  0.6 fps sim, 1–2.9 fps pan/zoom, 2.41 GB JS heap (~4.4 GB process peak).
  Metrics + screenshots in `bench/results/`, harness in
  `tests/manual-spike.mjs`. We build our own renderer/sim per §4–§6; M2/M3
  are unblocked but need a written renderer plan before code.
- **M1 — done (2026-07-31).** Streaming CSV scanner + `EdgeIngest` in
  `skein-core` (chunk-safe quotes/CRLF, header capture, skipped-row
  accounting); batch `push_chunk`/`finish` on `skein-wasm::IngestSession`;
  ingest worker streams `File.stream()` through WASM and persists
  CSR + dictionary to OPFS (`web/src/workers/`, formats in `opfs.ts`);
  drop-zone UI with stage progress and a recent-graphs list backed by OPFS.
  Real-hardware numbers (M3 Air, `bench/results/ingest-medium_csv-*.json`):
  152 MB / 10M-edge CSV ingests in ~2 s wall — parse 1.3 s, CSR 0.06 s,
  OPFS 0.06 s — 30× under the §9 60 s budget. Native CSV bench added to the
  D5 ratio gate (`csv_secs`; enters the baseline at the next deliberate
  refresh). The privacy gate now runs the full ingest pipeline under load.
  `npm run build:wasm` (wasm-pack) is required before dev/build; CI installs
  it via taiki-e/install-action.
- **M2 — done (2026-07-31).** Own render path per D7: WebGPU renderer
  (vertex pulling from storage buffers, instanced node quads + line-list
  edges) with a WebGL2 fallback sharing the same flat buffers (positions in
  an RG32F texture, endpoints as uint attributes); pan/zoom camera
  (`web/src/render/`); `GraphView` with backend/fps HUD and deterministic
  seeded positions until M3. Worker `load` message expands CSR from OPFS to
  interleaved endpoint pairs and transfers them. Edge drawing is fill-bound
  (D8): a seeded-permutation sample capped at 300k edges is drawn, HUD says
  so. Real-hardware gate passed (`bench/results/render-medium_csv-*.json`):
  1M/10M on WebGPU/Metal at min 40.6 / median 56.9 fps during scripted
  pan/zoom, ~81 MB JS heap. Harness: `tests/manual-render.mjs`.
- **M3 — done (2026-07-31).** Multilevel layout per §6, design + calibration
  history in D9: symmetrize + size-capped label-propagation hierarchy in
  `skein-core` (native: 1M/10M in 2.7 s, `hierarchy_secs` in the ratio
  gate); deterministic force sim twice — WGSL compute (`web/src/layout/gpu.ts`,
  integer fixed-point grid atomics per D2) and, since the D11 port, a Rust
  engine in `skein-core::layout` (force sim, seeding, prolongation and the
  multilevel driver) that the ingest worker runs via WASM whenever WebGPU is
  absent. Two-grid repulsion (fine 5×5 + 25 mid-range coarse bodies + far
  residual), FA2-style linear degree-dissuaded attraction, FR cooling;
  `cargo run --release --example layout_tune` is the fast calibration harness
  (generates the clustered graph natively, prints cluster separation metrics —
  use it before touching force params). GraphView
  computes-or-loads per-seed positions (OPFS `positions-<seed>.bin`),
  live-previews the finest level, re-layouts on seed change. Real hardware:
  clustered 20k/120k in 1.9 s @60 fps (planted communities clearly
  separated — the visual gate); medium 1M/10M in ~11 s wall incl. hierarchy
  (§9: 45 s), post-layout pan/zoom min 56 fps. Same-seed determinism is
  e2e-tested across fresh browser contexts (`tests/layout.spec.ts`).
  Known: grid-banding artifact in ultra-dense hairball cores (D9).
- **Distribution — done (2026-07-31), pulled ahead of M5 (D10).**
  `crates/skein-cli` builds a `skein` binary that embeds `web/dist` (build.rs
  → `include_bytes!`; a missing bundle yields an empty table plus a cargo
  warning, so `cargo test --workspace` still works without an npm build) and
  serves it over loopback with tiny_http, then opens the user's real browser.
  Deliberately not a webview: WebKitGTK has no WebGPU, so Tauri would
  silently downgrade Linux to WebGL2 + CPU sim — deferred to §13. The server
  exists because the app needs COOP/COEP (§8) and the D1 CSP, both of which
  fail *quietly*; the CSP now lives in three places and `server.rs`'s
  `csp_matches_headers_file` test fails on drift. Port 7373 is fixed because
  OPFS is origin-keyed and an ephemeral port would orphan ingested graphs.
  The binary is a second deployment path, so it runs the no-network gate as
  its own Playwright project (`cli`). Packaging: `dist` 0.32.0
  (`dist-workspace.toml`), whose `github-build-setup` runs wasm-pack + vite
  on each release runner — without it dist ships an assetless binary.
  `Dockerfile` self-hosts the same binary; **needs TLS**, since WebGPU and
  SharedArrayBuffer require a secure context.
- **Post-M3 — layout moved into Rust (D11, 2026-07-31).** `web/src/layout/cpu.ts`
  is gone; the algorithm lives in `crates/skein-core/src/layout.rs` and the
  no-WebGPU tier runs it in the worker through `LayoutSession` (skein-wasm),
  off the main thread. The port was verified bit-identical to the TS engine
  before deletion. TypeScript keeps only what must stay there: the WGSL engine
  and its main-thread orchestration (`multilevel.ts`), whose seeding and
  prolongation helpers deliberately mirror the Rust ones. The fallback node cap
  rose 150k → 1M on measured numbers (medium 1M/10M lays out in 23.9 s of the
  45 s budget on the fallback tier); `tests/layout-fallback.spec.ts` gates the
  path with WebGPU hidden, `tests/manual-layout-fallback.mjs` measures it.
- **M4 — done (2026-08-01).** Split in two. **Interaction — done:**
  hover, click selection, 1-hop neighbourhood highlight and id search (§10),
  no new dependencies. Per D12 only the *cursor-rate* work is main-thread
  TypeScript (`web/src/interact/`: a uniform pick grid over settled positions,
  a byte scan over the flat dictionary) because the WASM instance lives in the
  worker and main-thread code cannot call it. Everything worker-side stays in
  Rust: `skein-core::explore` (`neighbors`, `total_degrees`, bitmap dedup, six
  native tests). `load` ships `idBytes`/`idOffsets`/`degrees` and reads csr.bin
  once; both renderers grew a `setHighlight` overlay pass (WebGPU storage
  buffers, WebGL2 instanced attributes). `tests/explore.spec.ts` gates it,
  asserting *pixels* for the overlay and `tiny.csv` ground truth for
  neighbours/degrees. Real hardware (M3 Air, WebGPU, medium 1M/10M,
  `bench/results/explore-medium_csv-2026-07-31-22-49.json`): pick 0.09 ms
  median, search 4.1 ms median per keystroke, neighbourhood 30.8 ms of worker
  time, 446 MB main-thread heap. Pan/zoom read 30 fps — that was the machine's
  rAF ceiling that session (a blank page measured 30.2), so it is not
  comparable to M2's 56.9 median; re-take M2's numbers rather than diffing,
  since the explore panel also narrowed the fill-bound canvas.
  **Attributes — done (2026-08-01), so M4 is complete.** DuckDB-WASM, fully
  self-hosted and lazy (D14 has the measurements and the reasoning).
  `web/src/analytics/`: `duckdb.ts` owns the engine — the `eh` bundle only,
  reached through Vite `?url` imports so it can never come from a CDN, and
  behind a dynamic `import()` so a session that never opens the panel never
  fetches it; `attributes.ts` is the store. Two tables and a view —
  `nodes(idx, id, degree)` inserted as **Arrow straight from the §4.2
  dictionary** (`idOffsets`/`idBytes` already are an Arrow Utf8 array's two
  buffers, so no JS strings are built), `attrs_raw` from the attached CSV with
  DuckDB inferring types, and `node_attrs` as their LEFT JOIN. Because `degree`
  is in `nodes`, colour/size/filter and the §10 histogram all work with no
  second file. Duplicate join keys are dropped with `QUALIFY row_number()` and
  reported, as are unmatched rows (D4's promise). DuckDB runs in the worker it
  already owns — deliberately *not* wrapped in a second one — so
  `web/src/analytics/` is main-thread code that talks to it.
  Both renderers grew `setNodeStyle`: one packed u32 per node
  (`web/src/render/style.ts` — rgb + size code, size 0 hides the node *and*
  every edge touching it) driving colour, size and filtering from a single
  buffer. WebGPU reads it as a storage buffer via `unpack4x8unorm`; WebGL2 as an
  RGBA8 texture, which is also why its *styled* edge pass is instanced endpoint
  *pairs* — GL2 has no way to reach the partner vertex's attribute, and culling
  only one end of a line leaves a segment to the near plane. That draw call is
  unmeasured at the top tier, so `webgl2.ts` keeps the old flat line list too
  and an unstyled graph still takes it: no benchmark moves unless styling is on.
  Palette is capped at three categorical hues, measured not chosen (D14a).
  `tests/attributes.spec.ts` gates it against fixture ground truth
  (`bench/fixtures/*-nodes.csv`, now generated); the privacy gate drives the
  whole attributes path and asserts the wasm *was* fetched, so it is not
  proving "no CDN" about a bundle nobody loaded.
  Distribution: `build.rs` brotli-compresses embedded assets and `server.rs`
  negotiates `Accept-Encoding`, so the binary is **6.8 MB with DuckDB in it**,
  down from ~12 MB without it.
  Still open: the D9 banding artifact if it bothers real datasets; no
  real-hardware attribute timings yet (the numbers above are correctness, not
  §9 performance).
- **Post-M4 — draw budget follows zoom (D13, 2026-08-01).** Answers D8's
  "raise the cap once positions are no longer random", and answers it as
  *adaptive* rather than higher. Neither renderer culls, so vertex work is
  constant at every zoom and only fill moves: the fit view is the most
  expensive frame we draw and the fixed 300k cap was tuned for it, leaving
  every zoomed-in frame under-spent. `web/src/render/lod.ts` now sizes the
  seeded-prefix sample as `budget / f` with `f` the share of the graph in the
  viewport, counted per frame off the M4 pick grid's cell prefix sums
  (`visibleNodeCount`, O(rows)). Nodes are sampled too, through a new seeded
  `nodeOrder` buffer in both renderers. The policy is a pure function of the
  camera — deliberately not fps-driven, which would break D2 — and needs no
  alpha compensation, since a constant on-screen count already holds density
  constant. `tests/lod.spec.ts` gates it (needs the `small` fixture; CI now
  generates it).
- **Post-M4 — D13 calibrated, and corrected twice (D13a, 2026-08-01).** The
  headed run on the M3 Air produced corrections rather than three constants,
  because **the fit view is not the most expensive frame** — it loses in both
  directions. (1) Zooming out past fit collapsed 1M/10M from 57 to 7.8 fps,
  under §9's floor, with the drawn counts bit-identical: fixed-pixel node quads
  pack onto a shrinking screen and blended overdraw serialises, and `f` is blind
  to it because it saturates at 1 exactly there. Hence a second `coverage` term,
  normalised to the graph's *fit-view* area (viewport-relative silently thins
  the fit view to 541k nodes, since a square layout covers only 0.54 of a 16:10
  viewport). (2) There was no zoomed-in edge headroom to spend — edges are lines
  whose on-screen pixel length grows with zoom — so `maxEdges` drops 2M → 300k
  (sweep minima: 2M → 5.1 fps, 1M → 11.3, 500k → 20.4, 300k → 37.9) and now
  equals `edges`: at this tier the scaling term can only *lower* the edge count.
  Sweep minimum is now 34.8 fps across the full range; the fit view still draws
  exactly D8's cap. Data in
  `bench/results/lod-calibration-medium_csv-2026-08-01.json`. The old sweep
  could not have found any of this — it never reset to the fit view and its
  3.3× notches straddled the trough — so `tests/manual-render.mjs` now resets,
  sweeps both ways at 1.49× notches, and reports `sweepMinFps`.
- **Sample generation in the app (D17, 2026-08-02; sized by the user in D17a).**
  The drop zone can make its own data, for a device with no CSV on it — a phone,
  or a laptop that never ran `npm run fixtures`.
  `web/src/workers/generate.ts` synthesizes the edge list and
  streams it as CSV bytes through the *ordinary* ingest path (`ingestSource` in
  `workers/ingest.ts` takes either a `File` stream or generated chunks), so
  the generating device exercises parser, interner, CSR and OPFS for real.
  The UI is two number fields (nodes, edges) and one button, not the four
  presets it shipped with (D17a): bounds live in `sampleSpecError`, which the
  button disables on *and* `generateEdges` throws on, since the worker cannot
  trust a two-number message; `edges >= nodes` is enforced because ids exist
  only where an edge mentions them. Generation reproduces
  `bench/generate-fixtures.mjs` exactly — same RNG, same algorithm, same row
  order — which is why `tests/generate.spec.ts` compares the layout position
  hash of an app-generated 10,000/50,000 graph against dropped `tiny.csv`: that
  test is the only thing keeping the two copies of the generator in step. The
  app's copy of the *clustered* generator is gone with the presets (D17a), so a
  phone can no longer make a visibly clustered graph. The
  §7 gate drives generation too (D17: a "download a sample dataset" button is
  the one fetch this app must never make).
- **Phones are a supported viewport (D18, 2026-08-02).** The first screenshot
  from a real phone showed a 17rem sidebar eating 70% of a 390 px screen and a
  view that could not zoom at all — pan came free with pointer events, zoom was
  a `wheel` handler and touch never sends one. Below 48rem (`NARROW_QUERY` in
  `GraphView.tsx`, mirrored by the `@media` block at the end of `app.css`) the
  canvas takes the whole body and `.explore` becomes a bottom sheet: one 2.6rem
  handle when closed, raised by a tap that selects a node, overlaying the canvas
  rather than resizing it. The HUD's readings moved into a `.hud-stats` row that
  wraps under the title. Pointer handling now tracks a *set* of contacts, so two
  fingers pinch (midpoint pans, separation zooms); a second finger poisons the
  tap and lifting one of two re-seats the pan origin. Touch gets a fingertip's
  slack (pick radius 24 px, click slop 12 px) and no hover picking.
  `.canvas-controls` adds zoom in/out/fit buttons at every width — *fit* is also
  the way back from a view panned off into empty space. `tests/mobile.spec.ts`
  gates it at 390×844 with touch, driving the pinch over CDP because
  Playwright's touchscreen API is single-contact.
- **M5:** not started; see §11 — distribution (D10) is already done.
- **skein-native — a second, macOS-only front end (D15, 2026-08-02).** Parallel
  track; the web app is untouched and stays primary. `crates/skein-native` is a
  winit window on a wgpu/Metal surface with no browser, no webview and no WASM,
  built for graphs past §8's 4 GB wasm cap. Ported from the web tier: both WGSL
  shaders **verbatim** (diff them before debugging a visual difference) and
  `camera.ts`; everything else is `skein-core` unchanged. The force sim runs on
  the *renderer's* device, so positions never leave GPU memory. `store.rs`
  persists the CSR in its in-memory layout as `<source>.skein` and mmaps it, fed
  to the hierarchy through `skein-core`'s new `CsrView`/`build_hierarchy_view`.
  Real hardware (M3 Air, headed): `medium` 1M/10M lays out in **5.8 s** vs the
  browser's ~11 s; **`huge` 10M/100M** (1.72 GB CSV — a tier the browser cannot
  open at all) ingests in 29 s, lays out in 89 s, peak RSS 7.8 GB, no swapping,
  and reopens from a warm store in **0.95 s**. Deliberately has **no UI** —
  pan, zoom, a title-bar HUD and CLI flags; the egui port was dropped when the
  render path measured no faster than the browser's (that is the whole of D15's
  scope cut, and it is a decision rather than an omission). CI builds it in a
  `native` job on macOS and *excludes* it from the Linux jobs.
- **`skein-core::coarsen` rewritten as a counting sort (D15/N2).** `symmetrize`
  and `coarsen_once` no longer materialise a `Vec<(u64, f32)>` per edge; they
  stream triples into `build_dedup_counting`. Halved peak memory at 1M/10M
  (2.33 → 1.18 GB) and made the hierarchy 1.4× faster. This is **shared code the
  browser runs**: the pre-rewrite implementation is kept verbatim in the test
  module and three tests assert `f32` **bit** equality against it, because a
  different summation order is a different graph (D2).
- **Out-of-core hierarchy build (D16, 2026-08-02).** Answers D15/N2's closing
  "the remaining leverage is making that streaming". Where the build's
  *edge-sized* arrays live is now a policy: `skein-core::scratch` has
  `Scratch`/`Slab`, `HeapScratch` (default, and all wasm can use — §8) and
  `MmapScratch` (file-backed, so pages can be evicted where anonymous ones can
  only swap). `HierarchyLevel.graph` is a `CsrBuf`, not a `Csr`.
  `build_dedup_counting` → `build_dedup_banded`: no intermediate array at all
  (writes each band's triples into the output arrays and compacts each row
  forward in place), and rows are processed in bands so a mapping's dirty window
  stays bounded. Viable only because **every edge-sized pass is sequential in CSR
  row order** while everything random-access is node-sized: resident is O(nodes),
  streamed is O(edges). Opt-in via `skein-native --out-of-core`
  [`--scratch-dir DIR`] [`--band-mb N`]; **never point it at tmpfs** (swap-backed,
  evicts nothing, looks like it worked). Measured on this container at 1M/10M:
  anonymous memory *required* by the hierarchy build 650 MB → 500 MB (heap) →
  **80 MB (mmap)**, layout 15–20% slower out-of-core; at 10M/100M it is
  6500 → 5500 → **700 MB** (9.3×) for 2.5% slower. Peak RSS is the wrong
  metric and says the tiers are identical — unconstrained, mapped pages just stay
  resident; see D16.
  Bit-identity is the constraint: the same reference implementation the D15/N2
  tests kept is now asserted against **every** storage policy (heap, forced bands
  of 1/3/17/1024, mmap), and `cargo run --release --example out_of_core` prints
  per-level checksums that match across pre-D16, heap and mmap at 1M/10M. The
  browser path is untouched.

M0 facts worth keeping: headless Chromium falls back to SwiftShader even on
GPU machines — real-hardware runs must be headed; cosmos.gl 3.4 is luma.gl 9
on the WebGL2 adapter (no WebGPU today); its sim is equally slow on ANGLE
Metal and native OpenGL, so the D7 fail is not the §8 ANGLE pathology.

## Commands

```sh
npm install                      # web + tests workspaces
cargo test --workspace           # core tests
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
npm run fixtures                 # tiny + small fixtures, edges + {name}-nodes.csv
                                 # attributes (gitignored, required for tests)
npm run dev                      # app :5173, spike at /spike.html?fixture=tiny
npm run build -w web             # typecheck + production build (CSP injected here only)
npm run test -w tests            # privacy gate + app suite (needs fixtures + built web)
npm run spike -w tests           # M0 cosmos.gl spike; opt-in, not run by CI
cargo run -p skein -- --web-root web/dist        # the shippable binary (D10)
cargo run --release --example bench | node bench/compare-bench.mjs   # ratio gate
cargo run --release --example layout_tune    # force-param calibration (separation metrics)
cargo run --release --example out_of_core -- bench/fixtures/medium.csv --scratch mmap
                                 # D16: hierarchy build per storage tier, one tier
                                 # per process (peak RSS is a process high-water mark)
node tests/manual-explore.mjs medium.csv     # M4 pick/search/neighbour timings (headed, preview on :4173)
node tests/manual-demo.mjs clustered.csv     # re-record the README GIF (headed; ffmpeg)

# skein-native (macOS only, D15) — see crates/skein-native/README.md for flags
npm run fixtures -- huge                     # 10M/100M, ~1.7 GB, native-only tier
cargo run -p skein-native --release -- bench/fixtures/medium.csv
cargo run -p skein-native --release -- bench/fixtures/medium.csv --sweep
cargo test -p skein-native                   # excluded from the Linux CI jobs
```

In managed/remote environments, point Playwright at the pre-installed browser:
`CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (adjust to
whatever `ls /opt/pw-browsers` shows). Headless GL is SwiftShader — never use
its numbers for performance decisions (D3/D5).

## Non-negotiable invariants

- **Privacy (§7):** zero off-origin requests, ever. `tests/no-network.spec.ts`
  gates merges; extend it whenever the app grows a new code path. CSP is
  `connect-src 'self'` (D1) — injected at build, mirrored in
  `web/public/_headers`.
- **Flat typed arrays (§4.2):** no per-node/per-edge JS objects in any hot
  path. In Rust, algorithms live in `skein-core` (natively testable);
  `skein-wasm` stays a thin boundary.
- **Determinism (§6, D2):** all RNG explicitly seeded; same file + seed +
  machine + browser ⇒ same picture. No float atomics or scheduling-dependent
  accumulation order in force sims.
- **Benchmarks (D5):** performance claims become numbers in CI (ratio gate) or
  dated reports in `bench/results/` from real hardware. The committed native
  baseline is machine-class specific; refresh with
  `... | node bench/compare-bench.mjs --update` only deliberately.

## Gotchas

- Fixtures are generated, never committed; they live in `bench/fixtures/` and
  are served at `/fixtures/*` by a Vite plugin (dev + preview) — don't move
  them into `web/public/` (they'd get copied into dist).
- The CSP meta tag is build-only because Vite's HMR websocket would violate it
  in dev.
- The interner's hash needs its fmix64 finalizer — low-bit clustering made
  interning quadratic once already (see commit history).
- CI's bench ratio gate is warn-only until a baseline generated on the CI
  runner class is committed.
- **Nothing in CI touches the release path.** No job runs `dist plan` and none
  builds the `skein` binary with `web/dist` embedded, so a release-only breakage
  stays invisible until the tag is pushed — which is how v0.1.0 shipped without
  `[profile.dist]`, and how `skein-native` came to be planned as a second
  released app for all six targets. Before tagging, run `dist plan --tag=vX.Y.Z`
  locally: it exits non-zero when no package carries that version, and its
  release list is the only place a stray dist-able crate shows up. A new crate
  with a `main.rs` is dist-able **by default** — give it
  `[package.metadata.dist] dist = false` unless you mean to ship it.
- Releases are versioned on the `skein` package in `crates/skein-cli`, not on
  the workspace: the other three crates hold their own versions and are never
  released. Bump `crates/skein-cli/Cargo.toml` (and let `Cargo.lock` follow)
  before tagging.
