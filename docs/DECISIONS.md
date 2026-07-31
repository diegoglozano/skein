# Decisions

Running record of decisions that resolve ambiguities or contradictions in
REQUIREMENTS.md. Each entry states the decision, the reason, and what would
cause us to revisit it.

## D1 — CSP is `connect-src 'self'`, not `'none'`

The original brief said `connect-src 'none'`. That directive blocks *same-origin*
`fetch()` too, which breaks `WebAssembly.instantiateStreaming(fetch(...))`,
worker-side loading of `.wasm` binaries, and the lazy-loaded DuckDB-WASM bundle
contemplated in §13. The brief's own Playwright test permits "same-origin assets",
so the two enforcement mechanisms disagreed.

**Decision:** `connect-src 'self'`. The Playwright network-log test (§7) is the
authoritative guarantee: it fails on any request that is not the initial document
or a same-origin asset. CSP is defence-in-depth against third-party origins, not
the primary check.

**Revisit if:** we ever inline all wasm as base64 (then `'none'` becomes possible),
or CSP grows a directive distinguishing same-origin subresource loads from
arbitrary connections.

## D2 — Determinism is scoped to a given machine + browser

Bit-identical layouts across GPUs/browsers/driver versions are not achievable with
floating-point compute shaders. Cross-run determinism on the *same* machine and
browser is achievable and is what the reports use-case needs.

**Decision:** same file + same seed + same machine + same browser ⇒ same picture.
All RNG is explicitly seeded (seed exposed in the UI). The force sim must use
fixed-order reductions — no floating-point atomics, no accumulation order that
depends on scheduling. Document the cross-machine caveat in user-facing docs.

**Revisit if:** users demand cross-machine reproducibility; the options then are
fixed-point accumulation or a slower CPU layout path.

## D3 — M0 spike thresholds (cosmos.gl wrap-vs-build)

Facts that shape the decision: cosmos.gl is WebGL2 (regl-based) with no WebGPU
path and no out-of-core story. Wrapping it therefore shelves the WebGPU
compute-shader force sim and the uniform-grid repulsion design of §6 for v1.
That is acceptable **if** it hits the numbers.

**Decision — pass criteria, set before running the spike:** on the reference
mid-range 2023 laptop, cosmos.gl loading 1M nodes / 10M edges must

1. reach a visually stable layout in **< 90 s** from data handoff, and
2. sustain **≥ 30 fps** during pan/zoom after settling, and
3. not exceed **~2.5 GB** JS+GPU memory for the graph (leaves room for ingest
   and DuckDB within browser per-tab limits).

Pass ⇒ wrap cosmos.gl for v1 (M2/M3 collapse into integration work).
Fail ⇒ build the renderer/sim per §4–§6.

Headless CI runs use SwiftShader (software GL): functional validation and
regression *ratios* only — absolute fps/time numbers from CI are not evidence
for or against these thresholds. The verdict must come from real hardware.

## D4 — Two-file ingest (edge list + node attributes) stays in v1

§10's "metadata join key" implies a second file joined onto the edge list.
Kept in v1 because DuckDB-WASM does the join for free and the attribute-driven
colour/size/filter features are the point of M4. UI cost is one extra drop
target and unmatched-key reporting.

**Revisit if:** M4 slips; fallback is edge-list-only v1.

## D5 — Benchmarks: ratios in CI, absolute numbers on reference hardware

GitHub-hosted runners have no GPU and noisy CPUs, so §9's absolute targets can't
gate CI directly.

**Decision:** two tiers.
- **CI (gating):** ingest/interning/CSR micro-benchmarks compared against a
  committed baseline; fail on > 20% regression. Runs on every PR.
- **Reference hardware (tracked):** the full §9 matrix measured via `bench/`
  on the reference laptop; results committed as a dated report in `bench/results/`.

## D6 — Hosting and toolchain defaults

- Hosting target: **Cloudflare Pages** (`_headers` file for COOP/COEP).
- Real-dataset fixture: a SNAP graph (com-LiveJournal, ~34M edges, or
  com-Orkut) fetched by script, never committed.
- Rust pinned via `rust-toolchain.toml`; wasm built with `wasm-pack`.
- Node 22, npm workspaces.

## D7 — M0 verdict: build our own renderer (cosmos.gl fails D3 at the 1M/10M tier)

Spike executed 2026-07-31 on the reference laptop: MacBook Air 15" M3
(Mac15,13, 16 GB), Playwright Chromium 151, headed (headless falls back to
SwiftShader on this platform — D3's real-hardware caveat confirmed), with
background/occlusion throttling disabled. Renderer reported as
`ANGLE (Apple, ANGLE Metal Renderer: Apple M3)`. Fixture `medium`
(1M nodes / 10M edges, scale-free, seed 42). Full metrics in
`bench/results/spike-medium-2026-07-31-11-47.json`; supporting runs
(small/tiny, ANGLE-vs-OpenGL) alongside it. Harness:
`tests/manual-spike.mjs` (dev server on :5173, then
`node manual-spike.mjs <fixture> [simCapMs]`).

Against the D3 pass criteria:

1. **Stable layout < 90 s — fail.** 64 simulation ticks in the 120 s cap
   (steady 0.6 fps); the layout at cutoff is an unconverged blob
   (`spike-medium-midsim.png`). At that tick rate visual stability is tens of
   minutes away, not a near miss.
2. **≥ 30 fps pan/zoom — fail.** 1–2.9 fps after the sim was paused. The miss
   is structural, not marginal: even at 100k/500k the sim runs at ~7.5 fps and
   pan/zoom at 9–23 fps.
3. **< 2.5 GB memory — fail.** JS heap alone reached 2.41 GB used; total
   Chromium RSS peaked ~4.4 GB during setData+sim (browser baseline ~0.5 GB).

Additional observations:

- Identical numbers on ANGLE Metal and native OpenGL (`--use-angle=gl`), so
  this is not the §8 ANGLE pathology — cosmos.gl's WebGL2 quadtree sim is
  simply CPU/GPU-bound at this scale on integrated laptop GPUs.
- After sim + scripted pan/zoom at 1M/10M the canvas ended as a solid magenta
  frame with no page error (`spike-medium-final.png`) — a wedged GL
  context/framebuffer under memory pressure. Observed once; not needed for
  the verdict but disqualifying on its own if reproducible.
- Environment caveats, both immaterial at 10–50× margins: the laptop was on
  battery (Low Power Mode off; Apple-Silicon battery throttling is minor),
  and rAF capped at ~30 fps even on an empty page, which bounds the maximum
  observable fps but not the 0.6–7.5 fps results.

**Decision: build the renderer and force sim per §4–§6.** WebGPU compute
force sim with uniform-grid repulsion, WebGL2 render fallback, multilevel
layout. M2/M3 stay as scoped in §11 (render path first with precomputed
coordinates, then layout) rather than collapsing into cosmos.gl integration
work.

**Revisit if:** cosmos.gl ships a WebGPU compute path with order-of-magnitude
sim gains at ≥1M nodes, or the reference hardware class changes materially.

## D8 — Edge rendering is fill-bound; v1 draws a seeded sample (M2)

Measured 2026-07-31 on the reference laptop (M3 Air, our WebGPU renderer,
`bench/results/render-medium_csv-*.json`): drawing all 10M edges of the 1M-node
fixture with blending runs at ~2 fps, a 2M-edge subset at ~6 fps at the fit
view, 500k at ~24 fps, 300k at 40–60 fps. Vertex rate is not the problem —
fragment fill is: with pre-layout (random) positions the mean edge spans
hundreds of pixels, so 10M blended lines are billions of fragments per frame.
This resolves §13's "bundle, sample, or density field" question for v1 the way
the brief predicted: **sampling**.

**Decision:** the renderer draws at most a fixed cap of edges (currently 300k,
set by the ≥30 fps-at-fit-view gate on reference hardware). The endpoint pairs
are pre-shuffled with a seeded Fisher–Yates permutation at load, so the drawn
prefix is an unbiased, reproducible sample (D2), and the HUD says when
sampling is active — no silent caps.

**Revisit at M3:** a real layout makes most edges short (that is what a force
layout does), which changes the fill economics entirely — the cap should rise
or become adaptive once positions are no longer worst-case random. Density
fields or bundling remain the answer past ~20M edges.
