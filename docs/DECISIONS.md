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

## D9 — M3 force sim: grid-aggregate repulsion, FA2-style attraction (and what didn't work)

The §6 sim, as shipped, with the D2 determinism argument and the calibration
story — three schemes were measured before one passed the visual check on the
`clustered` fixture (40 planted communities, 20k/120k; a correct layout must
separate them).

**Repulsion.** Two uniform grids over the fixed 4096² world: 128² fine cells
and 16² coarse cells. Per iteration each cell aggregates {count, Σposition}
via *integer* fixed-point atomics (order-independent ⇒ deterministic; D2
forbids float atomics, integer sums commute exactly). Each node then repels
from: the 5×5 fine block (point-mass per cell, self removed), the 5×5 coarse
block as 25 distinct mid-range bodies (fine-block totals subtracted exactly
from the coarse cells containing them), and one residual far body (root −
coarse block). The first attempt lumped everything beyond the fine block into
the single far body: mid-range repulsion then has no direction, and the
communities never separated — one blob with speckle. Mid-range bodies are the
load-bearing part.

**Attraction.** Linear (ForceAtlas2-style) springs along the symmetrized CSR,
each edge divided by √((deg_i+1)(deg_j+1)) — plain FR d²/k attraction let
1M-node scale-free hubs (degree ~10⁵) crush the whole graph into a ball ~7×
denser than equilibrium; degree dissuasion alone was not enough because d²
grows too fast across the graph's diameter. Coefficient calibrated so a
typical edge balances repulsion at spacing ≈ kOpt = world/√n: per-edge
factor = attractionScale · avgDeg · kOpt / √(deg products). Verified by a
CPU parameter sweep (`tests/tune-layout.mjs`): separation ratio (mean
inter-centroid distance / mean intra-cluster radius) ≈ 10.7 at defaults,
stable under ±2× parameter changes.

**Everything else.** FR displacement clamp with exponential cooling
(schedules per level; coarsest starts hot from a seeded disc), gravity
0.03·d toward the world centre, positions clamped to the world. Multilevel:
coarsest 300 iterations, halving per finer level (min 40). CPU fallback
(no WebGPU) refines levels up to 150k nodes and prolongates the rest —
graceful degradation per §8, still deterministic.

**Measured (M3 Air, WebGPU/Metal, headed, `bench/results/layout-*`):**
clustered 20k/120k in 1.9 s end-to-end at 60 fps; medium 1M/10M in ~11 s
wall including WASM hierarchy (§9 budget: 45 s), post-layout pan/zoom min
56 fps. Determinism: bit-identical position hashes across fresh browser
contexts (Playwright `layout.spec.ts`); positions persist to OPFS per seed.

**Known limits, revisit at M4+:** visible grid-banding in ultra-dense
hairball cores (cell-aggregate repulsion can't resolve sub-cell structure —
candidate fixes: exact pairwise within own cell, or jittered grid origins
per iteration at the cost of determinism bookkeeping); the D8 edge-draw cap
stays at 300k though post-layout fps headroom (min 56) suggests it can rise.

## D10 — Distribution: a binary that serves the app to a real browser, not a webview

skein is a browser app and §11's M5 ships it as a static deploy. That leaves two
gaps: people who want to run it locally without trusting *any* host, and people
who want to self-host an instance. Both want an artifact you can download and
run. Three shapes were considered.

**Rejected — a desktop app (Tauri/Electron-style).** Tauri renders in the
*system* webview: WebView2 (Chromium) on Windows, WKWebView on macOS, WebKitGTK
on Linux. WebGPU is enabled by default in the first two but is not implemented
in WebKitGTK at all. The renderer (D7/D8) and the force sim (D9) are WebGPU
compute; on Linux the desktop app would silently fall back to the WebGL2 path
and the CPU sim — exactly the tier we rejected cosmos.gl for. Shipping a
"native app" that is slower than the same machine's Chrome is the wrong trade,
and the failure is invisible to the user. Electron avoids this by bundling
Chromium, at ~150 MB and a second browser engine to keep patched.

**Chosen — a static binary that serves the app over loopback.** `skein` embeds
`web/dist` (build.rs → `include_bytes!`) and serves it with tiny_http, then
opens the user's real browser. The browser is whatever they already trust and
keep updated, so WebGPU support is theirs, not ours. Privacy (§7) is unchanged:
same-origin only, and the binary is now covered by the no-network gate as its
own Playwright project, because it is a second deployment path with its own
header handling.

The server is a deliberate ~200 lines rather than a static-file crate, because
the app needs headers a generic file server won't set: COOP/COEP for
SharedArrayBuffer (§8) and the D1 CSP. Both fail *quietly* — the app loads and
degrades. The CSP now lives in three places (Vite's meta tag, `web/public/_headers`,
`server.rs`); a unit test reads `_headers` and fails on drift.

**Port 7373 is fixed, not ephemeral.** OPFS is keyed by origin and the origin
includes the port, so picking a free port per launch would orphan every graph
the user had ingested. A busy port is an error with an explanation, not a
silent fallback.

**Packaging is cargo-dist** (`dist`, v0.32.0), configured to match the
conventions already in use in `diegoglozano/revector`: `install-path =
"CARGO_HOME"`, `hosting = "github"`, `github-attestations`, and the same target
list including `x86_64-unknown-linux-musl`. The one piece of glue skein needs
and revector does not is `github-build-setup`: cargo knows nothing about
wasm-pack or Vite, so without a pre-build hook `dist` would cheerfully ship a
binary with no app inside it. It runs the web build on each target runner (~1
min against several minutes of Rust) and then asserts `web/dist/index.html`
exists. `cargo install` is *not* a supported path for the same reason —
crates.io would get a source package with no bundle.

The package is named `skein` (living in `crates/skein-cli/`) because dist names
every artifact after the package: the installer users curl is
`skein-installer.sh`, not `skein-cli-installer.sh`. Homebrew is configured but
commented out — the tap push needs a `HOMEBREW_TAP_TOKEN` secret this repo does
not have, and enabling it before the secret exists would fail the release job.

The v0.1.0 tag failed on all six targets with "profile `dist` is not defined":
`dist-workspace.toml` was hand-written rather than produced by `dist init`, and
`dist init`'s other side effect is adding `[profile.dist]` to the root
`Cargo.toml`. dist always builds `--profile dist`, so the omission breaks every
release build while leaving normal `cargo build` and the whole test suite green
— nothing in CI covers the release path. The lesson is in the README: dry-run
`dist build --artifacts=local/global` before tagging, which reproduces the
failure locally in a minute.

The same hand-written config cost a second, noisier failure: `build-setup.yml`
was placed in `.github/workflows/`, but it is a bare list of steps with no `on:`
and no `jobs:`. GitHub runs everything in that directory, so **every push to
every branch produced a failed run** — eight in a row before anyone read the red
X, which is the real damage: a permanently red history is indistinguishable from
a broken one, so it stops being a signal. The file now lives in `.github/`
(`github-build-setup = "../build-setup.yml"`, resolved relative to
`.github/workflows/`; `dist generate` reproduces `release.yml` byte-identically
from there), and `ci.yml` asserts that everything in `.github/workflows/` has an
`on:` trigger, so the fragment cannot be moved back quietly.

**Self-hosting is the same binary in a container** (`Dockerfile`, multi-stage:
node+rust builder → debian-slim runtime, non-root). The caveat that matters:
WebGPU and SharedArrayBuffer require a secure context, so an instance reached
over plain HTTP at a LAN address degrades exactly the way the rejected desktop
app would. Self-hosted deployments must terminate TLS.

**Revisit if:** WebKitGTK ships WebGPU (a Tauri build becomes a real option and
would drop the artifact to ~10 MB with an OS-native file picker); or the wasm
bundle grows past what is comfortable to embed, at which point the assets move
beside the binary rather than inside it.

## D11 — The layout algorithm lives in Rust; the no-WebGPU tier runs it in WASM

M3 shipped the force sim twice: the WGSL compute shader (`web/src/layout/gpu.ts`)
and a TypeScript CPU reference/fallback (`web/src/layout/cpu.ts`). The TS copy
was expedient — during calibration the force model changed three times, and
keeping both engines in one language avoided a wasm-pack rebuild per tweak —
but it contradicted the project's own rule that algorithms live in `skein-core`,
natively testable, with `skein-wasm` a thin boundary. No decision ever justified
it; it was leftover calibration velocity.

**Decision:** the algorithm is `crates/skein-core/src/layout.rs`. It owns the
force engine (`LevelSim`), the seeded disc scatter, prolongation, the per-level
schedules and the multilevel driver (`MultilevelLayout`). `skein-wasm` adds a
`LayoutSession` wrapper that coarsens and steps in chunks; the ingest worker
drives it and posts progress, so the whole no-WebGPU tier now runs in WASM off
the main thread. `cpu.ts` is deleted. What stays in TypeScript is only what must:
the WGSL engine, and the main-thread orchestration around it (`multilevel.ts`),
because the WebGPU device is main-thread-owned and the wasm module lives in the
worker. That leaves the seeding/prolongation helpers duplicated between
`multilevel.ts` and `layout.rs` — deliberate, and called out in both files;
they are ~20 lines each and the alternative is a second wasm instance on the
main thread.

**The port is exact.** Before deleting `cpu.ts` both implementations were run on
the same 80-node weighted graph with the same seed for 120 iterations
(exercising all three repulsion fields, degree-dissuaded attraction, cooling and
clamping): all 160 output floats were bit-identical. The Rust module keeps that
honest with a mulberry32 test pinned to values logged from the TS generator, a
determinism test, a world-bounds test, a clique-separation test and a multilevel
test that checks planted communities separate.

**The fallback node cap rises from 150k to 1M — measured, not guessed.** The old
`CPU_MAX_NODES = 150_000` bounded the TS engine; levels above it got
prolongation only. Measured on the reference laptop (M3 Air, headed Chromium
with `navigator.gpu` hidden, WebGL2 renderer, harness
`tests/manual-layout-fallback.mjs`, results in
`bench/results/layout-fallback-*`):

- `small` 100k/500k — **3.8 s** end to end, all three levels simulated
  (~27 ms/iter at 100k nodes, versus 21 ms/iter native: WASM costs ~1.3×, not
  the 2× assumed).
- `medium` 1M/10M — **23.9 s** of §9's 45 s budget: 4.9 s hierarchy, then
  1.6 / 1.5 / 4.6 / 11.3 s per level, the last being the full 1M-node level at
  40 iterations. Post-layout pan/zoom on WebGL2 held 43.8 fps min, 80 MB JS heap.
  With the cap at 400k the finest level was prolongation-only and the run took
  12.1 s — half the time for a visibly blurrier picture, and 33 s of budget left
  unspent. Simulating it is the better trade.
- `clustered` 20k/120k — 1.5 s, communities cleanly separated (the D9 visual
  gate, now passing on the fallback tier too).

So the cap is **1M nodes**: everything inside §9's top tier gets a real sim on
the fallback path, and larger graphs still degrade gracefully rather than blow
the budget (2M/20M would extrapolate to ~47 s, past it).

**Calibration and benchmarks.** `tests/tune-layout.mjs` (which esbuild-bundled
`cpu.ts` into Node) is replaced by `cargo run --release --example layout_tune`,
which generates the `clustered` graph natively from the same xorshift64* stream
as `bench/generate-fixtures.mjs` and prints the same separation metrics — 10.75
to 11.03 across the ±2× parameter sweep, matching D9's ≈10.7 from the TS
harness, which is independent evidence the port is faithful. It stays a
standalone tool rather than joining the D5 ratio gate: it is a quality metric
(cluster separation) rather than a throughput one, its runtime is seconds not
milliseconds, and a force-parameter change is *supposed* to move it — a gate
there would fire on every deliberate tuning commit.

**Revisit if:** the reference hardware class changes (the cap is a wall-clock
budget, so it moves with the machine); or a future tier needs the layout on the
main thread, which would justify a second wasm instance and retiring the
duplicated TS helpers.

## D12 — Explore state stays on the main thread; neighbour queries go to the worker

M4's interaction layer splits along one line: **what the cursor needs at frame
rate lives on the main thread; what needs the full CSR lives in the worker.**

**Main thread.** Hover hit-testing (`web/src/interact/pick.ts`, a uniform grid
over the laid-out positions) and id search (`interact/search.ts`, a byte scan
over the flat dictionary). These two are TypeScript, which is a deliberate and
*narrow* exception to "algorithms live in `skein-core`": the WASM module is
instantiated in the ingest worker, so main-thread code cannot call it, and
routing a `pointermove` through `postMessage` would lag the cursor by a frame
*and* stall entirely while the worker is running a fallback-tier layout. The
alternative is a second wasm instance on the main thread — the same trade D11
declined for the layout helpers. Everything stays flat typed arrays (§4.2); the
pick grid is 8 bytes per node, built once when positions settle (two O(n)
passes, too expensive to redo per preview tick, which is why picking only wakes
up after the layout finishes).

The exception covers *only* main-thread code. Anything running in the worker
has WASM available and therefore belongs in `skein-core`: `neighbors` and
`total_degrees` live in `crates/skein-core/src/explore.rs` with native tests,
and the worker just moves buffers. The first draft of this change hand-rolled
both in TypeScript inside the worker — the same mistake D11 corrected for
`cpu.ts`, and it is worth naming so it is not made a third time.

To pay for this the worker now transfers the dictionary (`idBytes`,
`idOffsets`) and a `degrees` column with the graph. At 1M nodes that is 8 MB of
fixed cost by construction (`4(n+1)` offsets + `4n` degrees) plus the id bytes
themselves, which are dataset-dependent — ~8 MB for ids the width of
`n0`–`n999999`. Against the ~81 MB JS heap measured in M2, and it buys the pick
grid its input; the alternative is asking the worker for every id we draw.

**Worker.** The 1-hop neighbourhood, because it needs `targets` (40 MB at 10M
edges) which the main thread has no reason to hold. Selection is click-rate,
so a round trip is cheap. The stored CSR is directed, so in-neighbours cost a
full scan of `targets`; that beats keeping a **reverse CSR resident for a
click-rate feature**. Dedup is a bitmap over node indices, not a hash set: a
hub with a million neighbours costs n/8 bytes and no per-neighbour allocation.
The CSR is cached per graph (as a *promise* — OPFS grants one sync access
handle per file, so two overlapping reads would make the loser throw) and
dropped on re-ingest, since a re-imported file reuses its graph id. Degrees are
likewise out + in — out-degree alone understates hub nodes badly on an edge
list read as a network. Degree and neighbour count legitimately differ (the
1M/10M run below shows `degree 1,731 · 1,724 neighbours`): degree counts edge
endpoints, neighbours counts distinct nodes.

Results are capped: 20k neighbours to the renderer, 100 into the sidebar list,
50 search hits. The UI says when a list is a prefix rather than the whole set.

**Measured on reference hardware** (M3 Air, headed Chromium, WebGPU/Metal-3,
`medium` 1M nodes / 10M edges, `bench/results/explore-medium_csv-2026-07-31-22-49.json`,
harness `tests/manual-explore.mjs`). The claims this decision rests on are
numbers, per D5:

- **Pick: median 0.09 ms, max 0.89 ms** per hit-test. The grid is doing its
  job — a linear rescan of 1M positions would be ~100× that, per pointermove.
  Query cost is bounded by construction: the pick radius is a fixed number of
  *screen* pixels, so zooming out grows it without limit in world units, and
  `MAX_REACH_CELLS` clamps a query to ~4k cells rather than letting it degrade
  into the full scan the index exists to avoid.
- **Search: median 4.1 ms per keystroke, worst 35.8 ms**, over ~8 MB of
  dictionary. A query matching nothing costs 4.5 ms, not a full scan, because
  the loop stops once neither bucket can still change the ranking — before that
  fix a miss scanned all 1M ids on every keystroke. 35.8 ms is one dropped
  frame on a keystroke; acceptable, and the fix if it grows is an n-gram index
  over the same bytes, not per-node JS strings.
- **Neighbourhood: median 30.8 ms** of worker time per selection, including the
  O(n+m) reverse scan at 10M edges. Off the main thread, so the render loop
  does not see it; the earlier "a few ms" guess in this document was wrong by
  ~10×, which is the reason D5 exists.
- **Pan/zoom after selection: 30 fps** — but that is the **rAF ceiling on this
  machine in this power state**, not our limit: a blank page measured 30.2 fps
  in the same session. It clears §9's ≥30 fps, and it is *not* comparable to
  M2's 56.9 median, which was captured when rAF was running at 60. Two things
  changed that would affect a real comparison anyway, so M2's numbers should be
  re-taken rather than diffed: the explore panel takes 17rem from a fill-bound
  canvas (D8), and `manual-render.mjs`'s cursor moves now also drive picking.
- **Main-thread heap: 446 MB** after exercising search, six selections, a hover
  sweep and pan/zoom. Well inside budget, but far above M2's ~81 MB, which was
  sampled right after load and before any of this existed.

**Testing.** The renderers implement the highlight overlay separately (WebGPU
storage buffers vs. WebGL2 instanced attributes) and a bad GL draw call raises
no exception, so `tests/explore.spec.ts` asserts *pixels*: clearing a selection
leaves the camera untouched, so the two frames may differ only by the overlay.
That assertion was checked against a deliberately broken draw before being
trusted. Headless Chromium has no WebGPU, so CI covers the WebGL2 overlay and a
headed run on the reference laptop covers the WebGPU one (D3's caveat again).
Neighbour and degree assertions use ground truth read out of `tiny.csv`, not the
app's own earlier output — the first version of the test compared the app to
itself and would have passed on a garbled dictionary decode.

Three failure modes found in review are worth recording, because none of them
raise an error and all three were invisible to the tests as first written:
a fresh `Camera` on a re-layout kept its 1×1 default (the viewport was only set
when the canvas backing store changed), which made every node quad cover the
screen and **hung the tab**; a UA-cancelled pointer gesture latched `dragging`,
which killed hover permanently; and the untagged `{type:'error'}` channel let a
failed selection abort an in-flight layout. Errors now carry the `request` that
failed, and `tests/explore.spec.ts` covers the re-layout case.

**Revisit if:** search stops fitting in a keystroke's budget at 1M nodes (the
fix is an n-gram index over the same bytes, not per-node JS strings); or a hub
selection makes the 30.8 ms reverse scan visible, which would justify building
the reverse CSR once per graph — it is one O(n+m) pass, so it pays for itself
after a single extra click if the memory is ever affordable.
