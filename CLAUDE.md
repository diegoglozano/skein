# CLAUDE.md

Orientation for a fresh session. Read REQUIREMENTS.md top to bottom before
writing code — it is the brief. docs/DECISIONS.md records resolved design
questions (D1–D11); don't relitigate them without new evidence.

## Roadmap and current status

The roadmap is REQUIREMENTS.md §11 (M0–M5). Status as of 2026-07-31:

- **Done — scaffold (pre-M0):** repo layout per §12; `skein-core` interner +
  CSR builder (tested, benchmarked: ~3.1M interns/s, 10M-edge CSR in ~0.2s on
  a dev container); `skein-wasm` boundary compiles for wasm32; web shell with
  privacy badge + build-time CSP; deterministic fixture generator; Playwright
  no-network privacy gate (passing); CI (fmt/clippy/tests/wasm32/bench-ratio +
  build/privacy/spike).
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
- **M4 — next up:** DuckDB-WASM attributes, filters, search, hover,
  selection (§10; D4 two-file ingest). Also: raise the D8 edge cap
  (post-layout headroom), and the D9 banding artifact if it bothers real
  datasets.
- **M5:** not started; see §11 — distribution (D10) is already done.

M0 facts worth keeping: headless Chromium falls back to SwiftShader even on
GPU machines — real-hardware runs must be headed; cosmos.gl 3.4 is luma.gl 9
on the WebGL2 adapter (no WebGPU today); its sim is equally slow on ANGLE
Metal and native OpenGL, so the D7 fail is not the §8 ANGLE pathology.

## Commands

```sh
npm install                      # web + tests workspaces
cargo test --workspace           # core tests
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
npm run fixtures                 # tiny + small fixtures (gitignored, required for tests)
npm run dev                      # app :5173, spike at /spike.html?fixture=tiny
npm run build -w web             # typecheck + production build (CSP injected here only)
npm run test -w tests            # privacy gate + spike (needs fixtures + built web)
cargo run -p skein-cli -- --web-root web/dist    # the shippable binary (D10)
cargo run --release --example bench | node bench/compare-bench.mjs   # ratio gate
cargo run --release --example layout_tune    # force-param calibration (separation metrics)
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
