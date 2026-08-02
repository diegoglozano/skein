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

## D13 — The draw budget follows zoom: hold on-screen primitives constant (post-M4)

Reported as a feel: "the layout is way faster when I zoom in — probably because
we're drawing fewer nodes/edges." Half right, and the half that is wrong is
the useful half.

We are not drawing fewer of anything. Neither renderer culls: every frame
submits `nodeCount` instances and `min(edgeCount, cap)` line vertices no matter
where the camera is, so vertex work is *constant* across zoom levels. What
changes is fill. At the fit view every primitive lands on screen at once —
1M node quads at a fixed 2.5·dpr px plus the edge sample, all alpha-blended
over each other — and D8 already measured that this, not vertex rate, is what
costs. Zoomed in, the rasterizer discards nearly everything after the vertex
shader and the fragment cost collapses. The fit view is the most expensive
frame the app ever draws, and it is the one we tuned the cap for.

So the cap was answering the wrong question. A constant 300k prefix is the
number the *worst* frame can afford; every other frame was under-spending it.

**Decision:** the sample size becomes a function of the camera — draw
`budget / f` primitives, where `f` is the fraction of the graph inside the
viewport, clamped to the graph size and to a vertex-work ceiling. At the fit
view `f = 1` and this is D8's cap exactly, so nothing regresses; zoomed in it
spends the headroom that was being reserved for a frame we are not drawing.
One knob, both directions. Node counts get the same treatment, which needs a
seeded node-order buffer (a prefix of *index* order is not a sample: interner
order is CSV first-seen order, and in a preferential-attachment graph the low
indices are the hubs).

`f` comes from the M4 pick grid, which already stores per-cell prefix sums:
counting the nodes in a world-space rectangle is one subtraction per visible
grid row, ≤1024 of them, so it runs per frame on the main thread. The obvious
cheaper estimate — viewport area over bounding-box area — is wrong in exactly
the place it matters: a force layout concentrates mass in cluster cores, so it
under-estimates `f` when zooming into a dense core and would overshoot the
budget precisely there.

**Two properties this must not lose.**

- *Purity.* The natural way to write adaptive quality is an fps feedback loop.
  That would make the rendered image depend on machine load and frame history,
  and §6/D2 promise the opposite: same file + seed + machine + browser ⇒ same
  picture. Nothing in the policy reads a clock, and for the same reason there
  is no temporal smoothing of `f`. `tests/lod.spec.ts` reads the budget twice
  at a fixed camera and requires bit-identical answers.
- *No alpha compensation.* Holding the on-screen count constant already holds
  apparent density constant — zooming in shrinks the viewport and raises the
  sample rate together, so primitives entering at the sample boundary replace
  ones leaving at the viewport edge. Scaling alpha by the sample fraction on
  top of that double-corrects and makes the picture pulse while zooming.

**The ceiling is the honest part.** Sampling is uniform over the whole graph,
so drawing every edge inside a small viewport means submitting every edge in
the file, and clipping happens after the vertex shader — those vertices still
pay their position fetch. Past some point a deep-zoom frame stops being
fill-bound and becomes vertex-bound, which no sampling policy can fix. That is
what `maxEdges` marks. Beyond it the answer is real culling — a spatial index
over the settled layout feeding an indirect draw — which is strictly more work
for the case that is already fast, and is why it is not in this change.

**Not yet calibrated.** `DEFAULT_BUDGET` keeps D8's measured 300k edges (so
fit-view behaviour is unchanged and un-regressed), sets the node budget to 1M
(a no-op at §9's 1M tier, active at 5M) and `maxEdges` to 2M, which is a
placeholder, not a measurement. `tests/manual-render.mjs` now sweeps zoom
levels and reports fps against the on-screen count at each one; those three
numbers should come from a headed run on the reference laptop before any of
them is quoted (D5).

### D13a — the calibration run, and what it overturned (2026-08-01)

The headed run happened. It did not produce three numbers; it produced two
corrections, because **the premise above is wrong: the fit view is not the most
expensive frame the app draws.** It is beaten in *both* directions. Full data in
`bench/results/lod-calibration-medium_csv-2026-08-01.json`.

**Correction 1 — zooming out collapsed the 1M tier, and `f` could not see it.**
On medium (1M/10M), fit held 57 fps and two wheel notches out fell to 13.9,
staying at 7.8–13 all the way out — with `drawnNodes`, `drawnEdges` and
`visibleFraction` bit-identical on every row. The control isolates the driver:
small (100k nodes, the same 300k edges) holds a flat 60 fps through the same
sweep. Node quads are sized in *device pixels*, so zooming out does not shrink
them; it packs the same unshrinking, alpha-blended quads onto a shrinking patch
of screen, and blended overdraw serialises per pixel. This was invisible to the
policy by construction — `f` is the share of the graph *inside the viewport*, so
it saturates at 1 exactly when the graph begins shrinking below the viewport.
The budget had no lever in the one direction where the renderer was slow, and
§9's 30 fps floor was being missed by two scroll notches.

The fix is a second term: `coverage`, the graph's on-screen area as a multiple
of its **fit-view** area, giving `drawn = budget · coverage / f`. Normalising
against the fit view rather than the viewport matters and is not a detail —
`Camera.fit` matches the tighter axis and adds a margin, so a square layout in a
16:10 viewport covers only 0.54 of it at fit. Normalising by viewport area
thinned the fit view to 541k nodes: the one frame the budget was measured on.

**Correction 2 — there was no zoomed-in headroom to spend.** D13 says zooming
in should raise the cap because the clipped-away majority stops being paid for.
That holds for nodes and fails for edges, which are *lines whose on-screen pixel
length grows with zoom*: the surviving fraction falls, each survivor costs more
to fill, and the two effects substantially cancel. Minimum fps over a zoom-in
sweep, by ceiling: 2M → 5.1, 1M → 11.3, 500k → 20.4, 300k → 37.9. So `maxEdges`
drops 2M → 300k, and the worst frame in the range is about one notch *inside*
the fit view (coverage 2.03, `f` 0.912) rather than at either extreme.

That leaves `maxEdges === edges`, which is worth stating plainly rather than
hiding behind two knobs: **at the 1M/10M tier the scaling term can only lower
the edge count, never raise it.** The ceiling stays a separate knob because it
binds differently at other tiers.

After both corrections the sweep minimum is 34.8 fps across the full zoom range
in both directions, against 5.1 before, and the fit view still draws exactly
D8's cap — the one promise D13 made that survived.

**What this cost, procedurally.** The committed sweep could not have found any
of this: it never reset to the fit view (so "notches from the fit view" was
false), and its 3.3× notches jumped clean over the trough, sampling 60 fps on
both sides of a 5 fps frame. `tests/manual-render.mjs` now resets, sweeps both
directions at 1.49× notches, and reports `sweepMinFps` as the number that has to
clear §9 — a fit-view-only measurement is not evidence about the worst frame.

**Still open.** `f` has a resolution floor of one pick-grid cell (it pins at
2.40e-5 and stops moving), harmless only because the ceiling now equals the base
budget. The 4096-primitive visibility floor is a judgement call, not a
measurement. The node budget remains untested above 1M. And the cleanest fix for
correction 2 — dividing the edge budget by an on-screen-length term instead of
multiplying by coverage — was not attempted, because that term saturates once
edges are clipped by the viewport and needs its own calibration.

**Revisit if:** the 5M tier makes the node budget bind, which would test whether
the fixed 2.5 px point size (not the count) is what needs to move; or a deep-zoom
frame turns out to be vertex-bound below the *new* 300k ceiling, which would mean
real culling — a spatial index over the settled layout feeding an indirect draw —
stops being optional.

## D14 — DuckDB-WASM stays, self-hosted and lazy; the payload is the price

§13 left an open question: "is DuckDB-WASM's bundle size (~30 MB wasm)
acceptable for a tool that must work offline after first load? Measure; consider
lazy-loading it only when metadata is attached." M4's attributes half could not
start without answering it, so it was measured first (`@duckdb/duckdb-wasm`
1.29.0):

| bundle | raw | brotli q9 |
|---|---|---|
| `duckdb-eh.wasm` (exception handling, single-threaded) | 34.0 MB | 5.3 MB |
| `duckdb-mvp.wasm` (no EH) | 38.7 MB | — |
| `duckdb-coi.wasm` (pthreads) | 33.6 MB | — |

**Decision: keep DuckDB (§5, D4), ship exactly one bundle (`eh`), self-host it,
and load it only when the user opens the attributes panel.** The measurement
supports D4 rather than overturning it — 5.3 MB over the wire, once, for the
users who want SQL filters — so the "don't hand-roll this" instruction stands.

Three things follow, and each is enforced somewhere:

**Self-hosting is the privacy-critical part.** `getJsDelivrBundles()` is what
every duckdb-wasm example calls; it resolves the worker *and* the 34 MB wasm
from a CDN, and an app that did that would look and behave exactly like this
one. Both URLs are Vite `?url` imports instead, so they are emitted as
same-origin assets, and `connect-src 'self'` (D1) would block the alternative.
`no-network.spec.ts` now drives the whole attributes path — attach, join,
colour, filter — and additionally asserts that a `duckdb*.wasm` request *did*
happen, because a privacy test that proves "no CDN" about a bundle nobody
loaded proves nothing.

**Lazy is a product decision, not a build trick.** The panel starts switched
off behind a button that says what pressing it costs. `attributes.spec.ts`
fails if any `duckdb` request appears in a session that ingests, lays out,
renders and explores without opening the panel. A graph that already has a file
attached opens it automatically — that cost was accepted last time.

**One bundle, not three.** `mvp` exists for browsers without wasm exception
handling, which no browser with WebGPU-or-WebGL2 plus OPFS is; `coi` buys
threads for another 34 MB. Shipping only `eh` is 68 MB of `dist` not carried.

**Distribution: the binary got *smaller*.** `dist` went from ~1.5 MB to 36 MB,
which would have taken the D10 binary from ~12 MB to ~48 MB. So `build.rs` now
brotli-compresses every embedded asset over 4 KB (quality 9: 2.2 s and 5.3 MB
for the big one, against ~60 s and 5.1 MB at quality 11) and `server.rs`
negotiates on `Accept-Encoding` — served as stored to any browser, decompressed
on the fly for a client that does not offer `br`. The binary is **6.8 MB with
DuckDB in it**, against ~12 MB without it before. `Vary: Accept-Encoding` is
sent either way, and an `assets.rs` test decompresses every compressed row of
the embedded table, because a corrupt `br` body would surface as a blank page
rather than as an error.

**What it does not buy.** DuckDB does not replace the interner. The join is
`nodes(idx, id, degree) LEFT JOIN attrs`, and `nodes` is inserted as Arrow
straight from the §4.2 dictionary — `idOffsets`/`idBytes` *are* an Arrow Utf8
array's two buffers, so the graph crosses the boundary as two typed arrays
rather than as a million JavaScript strings. `degree` rides along, which is why
colour-by, size-by, filtering and the §10 degree histogram all work before any
second file exists.

**One buffer drives colour, size and visibility.** `web/src/render/style.ts`
packs a u32 per node — rgb in the low three bytes, a size code in the top one,
with code 0 meaning "hidden". The byte order is the one both backends decode for
free (`unpack4x8unorm` takes byte 0 as x; a little-endian u32 uploaded as RGBA8
puts byte 0 in `.r`), so one array feeds a WebGPU storage buffer and a WebGL2
texture with no repacking. A hidden node takes its edges with it, which needs
*both* endpoints in the edge vertex shader: WebGPU indexes the endpoint buffer
freely, but GL2 cannot reach the partner vertex's attribute, so the styled edge
pass there is `drawArraysInstanced(LINES, 0, 2, n)` over endpoint *pairs*.

That is a different draw call from the flat line list every committed benchmark
measured, and its cost at the top tier is **not measured**. So it is not on the
default path: `webgl2.ts` keeps both programs and both vertex-array bindings
over the same buffer, and a graph with no style buffer bound draws exactly what
it drew before. Only a session that has switched styling on can pay for the
change, and only on the fallback tier.

**Revisit if:** the wasm grows enough that 5.3 MB stops being a one-time cost
worth a shrug; or attributes turn out to be used by nearly everyone, which would
make the switched-off default a papercut rather than a courtesy; or a
second sequential context appears and the three-hue cap (below) starts hurting.

### D14a — the categorical palette caps at three colours, and that is measured

A graph layout is a scatter: any two categories can land on adjacent pixels, so
the palette has to hold under the *all-pairs* separation gate rather than the
adjacent-pairs one a bar chart gets away with. Against this canvas (`#0b0b12`),
run through the data-viz validator:

- **3 slots pass** (blue `#3987e5`, orange `#d95926`, aqua `#199e70`): worst
  all-pairs CVD ΔE 9.4, normal-vision ΔE 20.9.
- **4 slots fail, for every candidate fourth hue.** Normal-vision ΔE against the
  first three: violet 9.8, yellow 10.6, magenta 11.6, green 11.9, red 7.1 —
  all under the 15 floor, which is a hard fail that secondary encoding does not
  excuse (a full-colour reader cannot tell the pair apart either).

So a categorical column colours its three most common values and groups the rest
into one neutral, the legend is always present, and the panel says so. Numeric
columns get a 6-step sequential blue ramp — 8 steps put adjacent steps under the
ΔL 0.06 gap and they stop reading as distinct.

The assignment is computed **once per column, from the whole column**, and never
recomputed: a filter that changes which values are on screen must not repaint the
ones that survive it.

**Revisit if:** node marks grow enough to carry a second channel (shape, or a
ring), which is what would let identity survive past three hues.

## D15 — A native macOS app (winit + wgpu + egui), and the N0 spike that gates it

The browser build stays the primary artifact. This decision covers a *second*
front end for macOS that removes the browser entirely, motivated by three wants
that the browser tier cannot satisfy: multithreaded compute, graphs past the
WASM 4 GB linear-memory cap (§8), and a target of 100M+ edges.

**Not Tauri.** Tauri is a WKWebView plus a native Rust process. The compute half
is genuinely native — rayon, no 4 GB cap — but the renderer stays in the webview,
so positions must cross an IPC boundary on every layout preview tick: 8 MB at 1M
nodes, 80 MB at 10M, and unworkable at the 100M target. D10 rejected Tauri on
Linux WebGPU grounds; this rejects it on the layout→render handoff, which is a
macOS-specific and more fundamental objection. A hybrid (native wgpu surface
layered under a transparent webview, keeping the React UI) was considered and
declined: it keeps ~934 lines of working UI at the cost of routing all pointer
input across two layers, and M4's interaction surface is entirely pointer-driven.

**Chosen: fully native.** winit owns the NSWindow and input, wgpu presents to a
CAMetalLayer, egui draws the panels through the same surface. No webview, no JS,
no IPC. The layout compute shader writes a GPU buffer the render vertex shader
reads — the handoff is a binding, not a copy.

**What this costs and what it reuses.** `skein-core` (~2,100 lines: csv, ingest,
csr, interner, coarsen, explore, layout) is reused unchanged — its algorithms
already take `&[u32]` slices, which is exactly what an mmap derefs to. The
renderer (~435 lines) and the GPU layout (~664) port to wgpu with the WGSL going
near-verbatim, since wgpu consumes WGSL natively. `GraphView.tsx` and `App.tsx`
(~934 lines) are rewritten in egui; that is the real cost.

Two pre-existing compromises resolve themselves, which is corroborating evidence
that this is the grain of the codebase rather than against it. D12's main-thread
TypeScript exception (`pick.ts`, `search.ts`) existed *only* because the WASM
instance lived in the worker and main-thread code could not call it; natively
there is no worker, so both move into `skein-core` with native tests. D11's
duplicated seeding/prolongation helpers between `multilevel.ts` and `layout.rs`
collapse to the one Rust copy.

**Out-of-core, calibrated.** At 100M edges the symmetrized CSR with weights is
~1.6 GB and the whole working set lands near 3–4 GB — that is mmap-and-let-the-
page-cache-work, not streaming. True streaming starts nearer 1B edges. The
binding constraint at 100M is the **GPU**, not RAM: 800 MB of endpoint indices
cannot sit in a GPU buffer and draw at 60 fps, so the density-field rendering
that D8 deferred "past ~20M edges" becomes mandatory rather than optional.

### Staging

- **N0 — spike.** Port the renderer to wgpu in a winit window, load a fixture,
  measure. Gates everything below. Criteria are set out below, before the run.
- **N1 — walking skeleton.** mmap'd CSR store, `skein-core` layout driving the
  ported renderer, fixture loaded from argv. No UI. Produces the first honest
  native-vs-browser comparison at 1M/10M.
- **N2 — out-of-core.** On-disk CSR in the exact in-memory layout, mmap'd;
  ingest writes it directly. Push to 100M edges.
- **N3 — render at scale.** LOD and density-field edge rendering (D8's deferred
  answer). This is where 100M+ actually reaches the screen.
- **N4 — UI parity in egui.** Drop zone, explore panel, search, HUD, recent
  graphs; `pick`/`search` move into `skein-core`.

### N0 pass criteria, set before running

Recorded in advance per D5, and stated as a hypothesis that can fail:

1. **Correctness.** The ported WGSL renders the same fixture at the same camera
   to a visually identical frame. The shaders are shared source in spirit, so a
   divergence means the wgpu pipeline setup is wrong, not the shader.
2. **Fill ceiling — calibration, not pass/fail.** Record edges drawn at ≥60 fps
   at fit view. **The honest expectation is a modest gain, not a large one:** D8
   established that edge drawing is fragment-fill-bound, and fill rate is a
   property of the same M3 GPU. Native removes compositing and per-call
   validation, not fragments per second. A 300k → ~1M improvement would be a good
   result; a 10× would be a surprise worth explaining before it is believed.
3. **Frame pacing — the clean test.** D7 and D12 both measured rAF pinned at
   ~30 fps on a blank page on the reference laptop. Native presents on a display
   link. If native does not comfortably exceed 30 fps on a scene where the
   browser sits at that ceiling, the presentation-overhead hypothesis behind this
   whole decision is wrong.
4. **Memory.** Process RSS at 1M/10M, against the browser's ~81 MB JS heap (M2).

**Reconsider the render half if:** criterion 3 fails, or criterion 2 lands below
~2× the current 300k cap *and* 3 shows no headroom — that combination would mean
native buys little for drawing, and the case would rest on the memory ceiling and
out-of-core alone. Those remain sufficient reasons on their own, but the scope
should then shrink to N1–N2 rather than a full UI rewrite.

### N0 results and the resulting scope cut (2026-08-01)

The spike ran on the reference laptop (M3 Air, headed, real Metal adapter),
`medium` 1M/10M, harness `crates/skein-native` with `--sweep`. Against the
criteria set above:

**Criterion 1 — correctness: pass.** The ported WGSL renders the fixture; the
camera port carries four unit tests (fit, cursor-anchored zoom, pan direction,
zoom clamp).

**Criterion 2 — fill ceiling: no meaningful gain, as predicted.** Pipelined
(the only mode comparable to D8's rAF-driven browser numbers): 300k edges at
58.6 fps, 1M at ~12–15, 2M at 6.4. D8's browser figures are 300k at 40–60 and
2M at ~6. Native sits at the top of the browser's range and is indistinguishable
by 2M. GPU-serialized, the true per-frame cost is 300k → 29.8 fps, 1M → 10.0.
Fill rate is a property of the M3, and removing the browser does not create
fragments per second. This is what the criterion said to expect, and it is why
the scope below shrinks.

**Getting these numbers took three harness fixes, each of which produced
confident garbage first** — recorded because the failure mode is the point:
counting surface-refused frames as drawn (reported 64,867 fps at 10M edges);
an occluded window silently refusing every frame; and, subtlest, vsync-off
swapchain queueing letting the CPU run frames ahead, so wall time between
frames measured queue occupancy rather than rendering ("best 1894 fps, worst
4.0" on the same step). `Renderer::render` now returns whether it presented,
`#[must_use]`, and `wait_for_gpu` serializes on request. A wgpu uncaptured-error
handler is installed for the D12 reason: a rejected draw raises nothing and just
produces a fast empty frame.

**Criteria 3 and 4 (frame pacing, memory) were not completed** — the 5M and 10M
sweep steps were lost to window occlusion. They are not gating the decision
below, because that decision does not rest on render speed.

**Revised scope: N1–N2 only, no UI port.** The project's criteria are (a) ingest
and lay out *bigger files*, sampling for display being explicitly acceptable,
and (b) a real speed win somewhere. Measured against those:

- **Capacity — the justification.** The §8 4 GB WASM cap is structural: CSR,
  ingest buffers and positions must all fit inside it, and ~100M edges does not.
  `skein-core` already takes `&[u32]` slices, so an mmap'd store needs no
  algorithm changes. This does not require a benchmark to believe.
- **Layout — modest, and mostly capacity again.** The WGSL sim is the same
  shader either way; only the CPU half improves (hierarchy 2.7 s native vs
  ~4.9 s WASM, before rayon). ~11 s → ~8 s at 1M/10M. The real win is that past
  the 4 GB cap the browser cannot lay out at all.
- **Rendering — no win.** Criterion 2, measured.
- **Filtering — not evidence.** Native DuckDB would beat DuckDB-WASM, but M4's
  attribute half is unstarted, so this cannot justify anything today.

Therefore **N4 (porting `GraphView.tsx` + `App.tsx`, ~934 lines, to egui) is
dropped.** It was justified by "fully native is fastest", which criterion 2
disproved for the render path. The native binary gets a minimal shell — open,
pan, zoom, seed, HUD — and becomes *the tool for graphs too large for the
browser*, running beside the web app rather than replacing it.

**N3's density-field rendering is also dropped from the critical path**, because
sampling is an accepted answer for display: D8's seeded permutation already
gives an unbiased reproducible sample and is already ported.

**The hybrid (native surface under a transparent webview) is rejected here** on
a different ground than before: it would require `GraphView` to stop owning its
canvas, and the web app is to remain untouched.

**Revisit if:** a measured layout win at the 100M tier turns out not to
materialise (then the native tool is only an ingest/store play, and mmap alone
may not be worth a second front end); or the attributes work lands and native
DuckDB shows a filtering gap large enough to reopen the UI question.

### N1 results: the WGSL compute sim, ported (2026-08-02)

`crates/skein-native/src/gpu_layout.rs` + `shader_layout.wgsl` port
`web/src/layout/gpu.ts` to wgpu. The shader body is verbatim; its `const`
prelude is generated from `skein_core`'s constants rather than duplicated, so
the two engines cannot drift. The multilevel driver mirrors
`MultilevelLayout`'s scheme exactly (`COARSEST_ITERS` halving per level, floor
`MIN_ITERS`, same `HIERARCHY_TARGET_NODES`/`MAX_LEVELS` as
`web/src/workers/ingest.ts`) — a different schedule would make the numbers
incomparable rather than merely different.

The sim runs on the *renderer's* device, cloned into the layout thread, so
positions live in one GPU allocation that both the compute and vertex stages
address. `--cpu-layout` forces `skein_core`'s engine for A/B.

**Measured, reference laptop (M3 Air, headed), `medium` 1M/10M:**

| Engine | Total | Hierarchy | Sim |
|---|---|---|---|
| **native wgpu compute** | **6.63 s** | 2.88 s | 3.75 s |
| browser WebGPU tier (M3) | ~11 s | ~4.9 s | ~6.1 s |
| native CPU (`skein_core`) | 16.90 s | 2.88 s | 14.0 s |
| browser WASM fallback (D11) | 23.9 s | 4.9 s | 19.0 s |

`clustered` 20k/120k: 0.35 s native GPU, 0.78 s native CPU (browser: 1.9 s
end-to-end, 1.5 s on the fallback tier).

So the native GPU engine is **1.66× the browser's fast tier** end to end, from
1.7× on the hierarchy (native Rust vs the same code in WASM, matching D11's
measured ~1.3× WASM cost plus the win from not re-marshalling) and 1.6× on the
sim (same shader, no browser validation layer). **Criterion 3b is delivered**;
the earlier "~11 s → ~8 s" estimate in this document was made while the native
build was still running the *CPU* engine and comparing it against the browser's
*GPU* one, which was not a like-for-like comparison.

**The 513-second lesson.** The first correct GPU run took 513 s — 27× slower
than the CPU engine, with healthy output (no NaNs, sane extent). The shader was
never at fault: interactive mode had no edge-draw cap, so the renderer was
drawing all 10M edges every frame (~2 fps per D8) on the *same GPU* the sim was
using, and the compute queue was starved. Applying D8's 300k cap by default —
which `GraphView.tsx` has always done, for fill-rate reasons rather than this
one — took the same run to 6.63 s with **byte-identical position statistics**.
The browser never hit this because its cap predates the question. Sharing one
device between sim and renderer is what makes the zero-copy handoff possible and
is also what makes them competitors; the cap is now load-bearing for both
reasons.

**Guard added.** `position_stats` prints extent, centroid and a non-finite count
after every layout, flagging `** COLLAPSED **` or `** NON-FINITE **`. A wrong
compute shader is characteristically *fast* and wrong — a no-op dispatch, a bad
binding or a division producing NaNs all yield a quick, plausible-looking
result. This is the same class of failure as N0's three bogus fps measurements
and D12's silent WebGL2 draw, and it is now checked rather than assumed.

Determinism (D2) held incidentally: the 513 s and 6.63 s runs produced identical
position statistics, as did repeat runs. The CPU and GPU engines differ slightly
from each other, which is expected and in scope for D2 (same machine + same
engine, not across engines).

### N2 results: the mmap store, and where the capacity ceiling actually is (2026-08-02)

`crates/skein-native/src/store.rs` persists the CSR in its exact in-memory
layout (64-byte header, then the flat `u32`/`f32` arrays) beside the source as
`<source>.skein`, and memory-maps it on open. `skein-core` gained `CsrView` plus
`symmetrize_view` / `build_hierarchy_view`, all additive — the owning entry
points delegate, so the web and wasm paths are untouched. Ingest now streams the
CSV through a `BufReader` instead of `fs::read`, which at the 100M tier would
otherwise hold ~1.5 GB of text resident while the interner grew beside it.

**Measured, `medium` 1M/10M, M3 Air:**

| | first run (builds store) | second run (reuses) |
|---|---|---|
| load | 896–914 ms ingest | **0 ms** |
| layout | 6.72 s | 6.64 s |
| peak RSS | 2.40 GB | **2.33 GB** |

Store file: 54.9 MB. Positions identical across the round trip, so the store
preserves determinism (D2).

**What the store delivers: instant reopen. What it does not deliver: headroom.**
Peak RSS moved 3%. The capacity ceiling is not where D15 assumed it was — it is
not the input CSR's residency at all. It is `coarsen::symmetrize`, which
materialises a `Vec<(u64, f32)>` of every edge, mirrors it (doubling the vector),
then stable-sorts it. At 1M/10M that is ~20M 16-byte entries plus the sort's
scratch, and it dwarfs the mapping the store saved.

Extrapolated, this is the thing that blocks the 100M-edge target: the pair
vector alone would be ~6.4 GB before the output CSR exists. Streaming the input
does not help, because the transient is proportional to *edges*, not to how the
input was read.

**The fix, not yet done:** rebuild `symmetrize` as a counting sort — degree
histogram, prefix sum, fill — the same shape `Csr::from_edges` already uses. That
allocates only the output rather than an intermediate 16-byte-per-edge array,
should cut peak memory roughly 4×, and is likely faster as well. The constraint
is D2: the current stable sort is what makes the duplicate-weight merge
order-deterministic, so a counting-sort version has to reproduce that ordering
exactly, and it changes shared `skein-core` code that the browser also runs. It
needs the same bit-identical verification D11 applied to the `cpu.ts` port.

**So criterion 3a is half delivered.** The input side is solved — streaming
ingest, zero-parse reopen, borrowed adjacency into the hierarchy. The hierarchy
build is now the binding constraint, and 100M edges is not reachable until
`symmetrize` stops allocating per-edge. That this only became visible after the
store was built is the argument for measuring rather than reasoning: the mmap
was assumed to be the capacity story, and it was in fact worth 3%.

### N2 follow-up: `symmetrize` rebuilt as a counting sort — 100M edges reached (2026-08-02)

The pair-array bottleneck identified above is gone. `coarsen::build_dedup` is
replaced by `build_dedup_counting`, which takes an `emit` closure called twice —
once to count per-row sizes, once to fill — so callers stream their
(source, target, weight) triples instead of materialising them. `symmetrize_view`
and `coarsen_once` both use it.

**Why it is safe (D2).** A global stable sort by the packed `source<<32|target`
key is *exactly equivalent* to bucketing by source and stable-sorting each row by
target: both give ascending sources, ascending targets within a row, and
duplicates in emission order — which is what makes the `f32` weight merge
order-deterministic. The equivalence is not argued, it is tested: the previous
implementation is kept verbatim in the test module as
`build_dedup_reference`/`symmetrize_reference`, and three tests compare against
it over random weighted and unweighted graphs, hub-and-isolated-node shapes, and
a full `coarsen_once` round — asserting `f32` **bit** equality, not approximate
equality. Same discipline D11 used before deleting `cpu.ts`.

**Measured, `medium` 1M/10M:**

| | before | after |
|---|---|---|
| peak RSS | 2.33 GB | **1.18 GB** |
| hierarchy | 2.87 s | **2.06 s** |
| layout total | 6.64 s | **5.81 s** |

Halved the memory and got faster — the global sort and its scratch were costing
time as well as space. Positions bit-identical, as the tests require.

**Criterion 3a, delivered: `huge` (10M nodes / 100M edges, 1.72 GB CSV) lays out
natively.** New `huge` preset in the fixture generator; native-only by
construction, since this is past the browser's 4 GB wasm cap (§8).

| | first run | store reused |
|---|---|---|
| ingest | 29.0 s | **0 ms** |
| hierarchy | 51.8 s | 50.5 s |
| layout total | 91.4 s | 90.1 s |
| wall | 122.6 s | **92.3 s** |
| peak RSS | 5.06 GB | 7.12 GB |
| swaps | **0** | **0** |

Positions identical across both runs (extent 1065x1068, centroid 2399,1323, no
non-finite values), so determinism holds at this scale too. Store file: 559 MB.
Peak *footprint* including GPU allocations reached 11.3 GB on a 16 GB machine
with zero swapping — comfortable but not unlimited, which sets the next ceiling
honestly at roughly this order rather than an unbounded claim.

The browser cannot run this graph at any speed: the CSR alone exceeds the wasm
address space. That is the whole justification for the native binary, now
demonstrated rather than argued.

**Both criteria are now met.** 3b (faster): 5.81 s vs the browser's ~11 s at
1M/10M, 1.89x. 3a (bigger): 100M edges, which the browser cannot open.

### N2 follow-up 2: the renderer stops expanding every edge (2026-08-02)

The load path built interleaved endpoint pairs for *all* `m` edges, shuffled
them, and drew a 300k prefix — 800 MB of `u32` at the 100M tier, permuted in
full so that 0.3% of it could be used. `sample_edge_indices` replaces it with a
partial Fisher–Yates over a *virtual* identity array, storing only positions a
swap actually moved: O(k) time and memory regardless of `m`. Targets then come
straight from the mapping and sources from a `partition_point` search over the
offsets.

**Measured, `huge` 10M/100M:**

| | before | after |
|---|---|---|
| sample/expand | 1551 ms | **87–102 ms** |
| endpoint heap | 800 MB | **2.4 MB** |
| load path alone (`--no-layout`) | — | **712 MB, 0.95 s** |

So a 100M-edge graph opens and renders in under a second from a warm store.

**It did not reduce peak RSS, and that is worth recording rather than
glossing.** Peak went 7.12 GB → ~7.8 GB, stable across three runs (7.65, 7.82,
7.82 — so this is not measurement noise; RSS here is repeatable to ~2%). Two
things explain it. The peak occurs during the *hierarchy build*, long after the
load path, so a load-path saving cannot lower it. And sampling touches ~300k
scattered pages of the 559 MB store instead of walking it sequentially, which
appears to keep more mapped pages resident through that peak — trading ~0.7 GB
of mmap residency for 1.6 GB of heap and GPU. Net: much faster and much lighter
to *open*, marginally heavier at the *peak*.

The lesson repeats N2's: the win was real but not where the headline metric
looks. Peak memory at this tier is `symmetrize`, and the remaining leverage is
making that streaming rather than shaving the load path further.

**Behaviour change worth knowing:** a front-to-back partial shuffle selects a
different (equally uniform) subset than the back-to-front full shuffle it
replaces, so the same seed draws a different sample than previous builds did.
Same file + seed is still reproducible (D2); it is not bit-compatible with
earlier versions, and `GraphView.tsx` still uses the original scheme.

Sampler and source-lookup correctness are tested (distinctness, range,
determinism, seed sensitivity, full-permutation case, over-request clamping,
uniform coverage across the range, and `source_of` against a linear scan
including empty and leading-empty rows) — an off-by-one there would draw a
wrong but entirely plausible picture.

### D15 vs D13: the native draw budget is a fixed cap, deliberately for now

D15 was designed and measured against a `main` that predated D13/D13a, so its
renderer applies a fixed 300k edge cap where the web tier now sizes the sample
from the camera. The two are not in conflict at the fit view — D13a lowered
`maxEdges` to 300k at this tier and noted the scaling term can only *reduce* the
count there, so both front ends draw the same thing on the frame D8 tuned for.

They diverge away from it. D13a measured the fit view is *not* the worst frame:
zooming out past it collapsed 1M/10M from 57 to 7.8 fps with drawn counts
bit-identical, which is why `lod.ts` grew a coverage term. skein-native has no
such term and will hit that trough.

**Not fixed here** because the port is not mechanical: `lod.ts` counts the
visible share off the M4 pick grid's cell prefix sums, and skein-native has no
pick grid — D15 dropped the interaction surface along with the UI. Adding one
is worth doing on its own terms (it is also what hover and selection would
need), not as a rider on this change.

**Revisit when:** skein-native grows a pick grid, or a user reports the zoomed-
out trough on real data.

## D16 — The hierarchy build streams; edge-sized arrays become a storage policy

D15/N2 closed with a named next step: "Peak memory at this tier is `symmetrize`,
and the remaining leverage is making that streaming rather than shaving the load
path further." REQUIREMENTS.md §4.2 says the same thing from the other side —
at 100M edges the CSR is ~800 MB, "which is the point where streaming stops
being optional". This is that work.

**Decision.** Where the hierarchy build puts the arrays that scale with *edge*
count is a policy, not a hard-coded `Vec`. `skein-core::scratch` defines
`Scratch`/`Slab`; `HeapScratch` is the default and the only thing wasm can use
(§8); `MmapScratch` puts the same arrays in memory-mapped files. `HierarchyLevel`
holds a `CsrBuf` — offsets still a `Vec`, targets and weights wherever the
scratch put them. Everything reaching for a level goes through `CsrView`, which
D15 already introduced.

### Why file-backed is the whole difference

A 1.6 GB anonymous allocation can only go to swap. The same 1.6 GB in a file
mapping can be written back and evicted, and re-read on demand. Nothing else
about the algorithm changes; the pages just become reclaimable.

That is only *usable* because of an access-pattern property worth stating
plainly, since it is what makes out-of-core viable here and would not hold for
an arbitrary graph algorithm: **every pass over an edge-sized array walks it in
CSR row order.** Label propagation reads `sym.targets[e]` sequentially and
indexes `labels[]` randomly; the aggregation pass does the same; the force sim
reads each node's row in order. Everything random-access — labels, cluster
sizes, vote scratch, positions, offsets — is node-sized. So the resident working
set is O(nodes) and the streamed set is O(edges), which is exactly the shape a
graph too large for RAM needs.

### Two changes, not one

**`build_dedup_counting` becomes `build_dedup_banded`.** The D15/N2 version
allocated an intermediate `Vec<(u32, f32)>` of every triple *and* the output, so
the finest level cost 16 bytes per symmetrized arc. The new one writes each
band's triples directly into the output arrays at their pre-dedup positions, then
sorts and merges each row forward over the same region — dedup only shrinks a
row, so the compacting write cursor never overtakes the read position. Two
allocations instead of three, 8 bytes per arc instead of 16.

**Bands** are a locality device, not a capacity one. A band is a run of
consecutive rows holding at most `scratch.band_len()` triples; only that band's
region of the output is being written at any moment, which bounds the dirty
window over a mapping. `emit` now receives the row range so it can skip work
rather than have the builder filter it — without that, a banded build re-scans
the whole input per band through a `dyn FnMut`, and the extra passes dominate.
`HeapScratch` uses one band, so the heap path does exactly what it did before:
two emit passes, same allocations, same output.

### Bit-identity, which is the constraint (D2)

The same discipline D11 used before deleting `cpu.ts` and D15/N2 used for the
counting sort: the pre-counting-sort implementation is still in the test module
as `build_dedup_reference`/`symmetrize_reference`, and the tests now assert `f32`
**bit** equality against it across *every* storage policy — heap, forced bands of
1/3/17/1024 rows' worth of triples, and mmap — for random weighted and unweighted
graphs, hub-and-isolated-node shapes, a full `coarsen_once`, and a complete
multi-level hierarchy. A band size of 1 is in there deliberately: it makes every
row its own band, which is the case a boundary bug would survive larger bands.

At real scale the harness prints an FNV checksum per level. `medium` 1M/10M
produces identical checksums on all four levels across the pre-D16 code, the new
heap path and the mmap path. A different `f32` summation order would be a
different layout, so this is the claim that matters most.

### Measured (this container: 4 cores, 15 GB, `medium` 1M/10M)

Not the reference laptop — these are ratios and thresholds on commodity Linux,
which is what this particular claim needs, rather than the absolute timings D15
took on the M3 Air.

| | pre-D16 | D16 heap | D16 mmap |
|---|---|---|---|
| hierarchy | 4.71 s | 4.66 s | 5.35–5.63 s |
| peak RSS | 512 MB | 496 MB | 517 MB |
| **anonymous memory required** | **650 MB** | **500 MB** | **80 MB** |

**Peak RSS is the wrong metric here, and running the two tiers unconstrained
will say they are identical.** With 15 GB free the kernel has no reason to evict
anything, so mapped pages stay resident and count toward RSS exactly as
anonymous ones do. The difference is not how much is resident, it is whether it
*has to be*.

The bottom row is that question, and it is the result: the smallest
`RLIMIT_DATA` at which the build completes instead of aborting in the allocator.
`RLIMIT_DATA` bounds anonymous mappings and deliberately does not bound
file-backed ones, which makes it exactly the discriminator. The harness applies
it *after* ingest and after `malloc_trim`, so it measures the hierarchy build
rather than the pipeline — at the 100M tier ingest's own transient is larger
than anything the hierarchy needs out-of-core, and a process-wide `ulimit -d`
would measure only that. **8.1× less RAM required**, and what remains is the
node-sized arrays plus the input CSR, which `skein-native` would have mmap'd
rather than allocated.

The heap path's own improvement is smaller than the arithmetic suggests (650 →
500 MB, not 2×) and the reason is worth recording: the intermediate array this
change removed was only the *peak* at level 0, and at this graph's shape the
global peak is at level 2, where three levels are live at once and the old
output `Vec::with_capacity` never touched its slack. Halving level 0's transient
moved the global peak by a fifth. The mmap tier is where the capacity actually
comes from.

Layout is 15–20% slower out-of-core at this size, from the extra emit passes and
page faults. That is the trade being bought, and it only applies when the flag is
on. It shrinks with scale: at `huge` the same comparison is 110.0 s → 112.7 s,
2.5%, because the sort and propagation work grows faster than the paging does.

### And at the tier this exists for — `huge`, 10M nodes / 100M edges

| | pre-D16 | D16 heap | D16 mmap |
|---|---|---|---|
| hierarchy | 110.0 s | — | 112.7 s |
| peak RSS | 5471 MB | — | 4397 MB |
| **anonymous memory required** | **6500 MB** | **5500 MB** | **700 MB** |

**9.3×.** A 100M-edge graph coarsens in 700 MB of anonymous memory, and ~440 MB
of that is the input CSR the `skein-core` harness holds on the heap because it
has no store — `skein-native` maps it, so the hierarchy build proper is on the
order of 260 MB to produce and hold a 200M-arc level 0. The four levels are
byte-identical to the ones the pre-D16 code produces.

That is the claim D15 could not make: N2's store gave instant reopen and 3% of
the memory it was expected to, and this is where the capacity actually came
from.

### Do not put the scratch on tmpfs

`/tmp` is tmpfs on most Linux installs, and tmpfs pages are backed by swap rather
than a disk — a scratch file there is page cache that can only be evicted to swap,
or on a swapless machine not at all. It would look like it worked and reclaim
nothing. So the scratch directory is a caller argument with no temp-dir default,
and both entry points default it to the directory the graph came from (beside
`<source>.skein`, which is already known to have room for this graph).

### Scope, honestly

- **Opt-in, not inferred.** `skein-native --out-of-core`. Choosing it from free
  memory would mean a wrong guess silently takes the slower path, and D5's rule
  is that the tier a run used should be a stated fact.
- **The browser is untouched.** wasm has one linear memory and no files (§8);
  `MmapScratch` does not compile there and the web path still gets
  `HeapScratch`, byte for byte what it got before. §4.2's OPFS-streaming note
  remains open for the browser tier and is a different piece of work.
- **Node count still bounds RAM.** ~12 bytes per node of build scratch plus the
  layout's positions. At 10M nodes that is a few hundred MB, so the ceiling this
  moves is edges, not nodes.
- **~4.29B arcs is the format's ceiling**, not this function's — §4.2 makes CSR
  offsets `u32`. It is now an explicit assert with a message rather than a silent
  wrap.
- **Ingest is the next anonymous transient**, and it is now the largest one in
  the native pipeline: building the CSR from a 1.72 GB CSV peaked at 1366 MB
  here. It is a one-time phase — D15/N2's store makes reopening cost 0 ms — so
  it bounds the first run on a given file, not every run. Moving it would be
  separate work.
- **The GPU sim still uploads each level to device memory.** `--out-of-core`
  makes a level cheap to *hold*, not cheap to *simulate on the GPU*, because
  `LevelSim` copies offsets/targets/weights into wgpu buffers. At the extreme
  tier it pairs with `--cpu-layout`, which reads the mapping in place. This is
  the same GPU-capacity observation D15 opened with, arriving from the other
  direction.

**Revisit if:** a real dataset makes the extra emit passes hurt more than the
capacity is worth (the fix is a larger band, or emitting into a per-band buffer);
node-sized arrays become the ceiling in turn (then they need the same treatment,
and `labels`/`vote_*` are randomly accessed so it would be a genuinely harder
problem); or the browser tier needs the same thing, which OPFS cannot serve the
same way because it has no mmap.

## D17 — Sample graphs are generated in the tab, and are the fixture graphs

Testing the app on a phone (or any device that has never run `npm run fixtures`)
ran into the obvious wall: there is no CSV on it, and there is no way to put one
there that does not involve a download. §7 forbids the download, and it forbids
it for exactly the right reason — "fetch a demo dataset" is indistinguishable at
the network layer from "upload the user's graph".

**Decision:** the drop zone asks how big, and generating synthesizes the edge
list in the tab and feeds it through the ordinary §4 ingest path — CSV bytes
into the WASM parser, interner, CSR, OPFS, manifest. Not a shortcut that builds
a CSR directly: the device doing the generating is the device whose ingest path
we came to test, and a synthetic-only path would be the one path a phone never
exercises.

Two consequences worth stating.

*The generator is the fixture script's.* `web/src/workers/generate.ts`
reproduces `bench/generate-fixtures.mjs` — same xorshift64\* stream, same
preferential attachment, same `n<i>` ids, same row order — so asking for a
fixture's numbers yields that fixture's graph, edge for edge. That makes every
number, screenshot and bug report comparable no matter which side produced the
data. It is a *copy*, so `tests/generate.spec.ts` generates 10,000/50,000,
ingests `tiny.csv`, and compares the layout position hash (D2): identical
graphs, identical picture, and divergence is a red test rather than a slow
surprise. The alternative — importing the Node script into the web build —
costs a Vite `fs.allow` exception and an untyped `.mjs` import for forty lines
of arithmetic.

*BigInt stays in the RNG.* It is the bulk of generation (~1 µs an edge), and a
hand-rolled 32-bit-lane u64 would be a second thing to keep bit-identical with
the fixture script, for a constant factor that only shows up in the millions —
a size no phone can render anyway. Anything up to `small` (100k/500k) is
sub-second work on a laptop.

Generation is now part of the §7 gate (`no-network.spec.ts`), which is the point:
the feature most likely to grow a fetch is the one that hands you data.

### D17a — the size is the user's, not a preset (2026-08-02)

The first cut shipped four buttons (`tiny`, `clustered`, `small`, `medium`),
which answered "give me some data" but not "give me a graph the size of the one
I am about to load" — and the latter is what the sizes were being used for, by
hand, in every performance conversation. The buttons are now two number fields
and one *generate graph*.

Three things fall out of that.

*Bounds are part of the feature.* An empty field or a typo used to be
impossible; now it allocates. `sampleSpecError` is the single source of truth
and both ends call it — the button is disabled on it, and `generateEdges`
throws on it, because the worker is a message endpoint and a message carrying
two numbers cannot trust the UI that usually sends it. The ceilings (5M nodes,
20M edges) are the sizes this path has been run at, not round numbers:
`medium` was 1M/10M and generation costs 8 bytes an edge plus the CSV it
streams.

*Edges ≥ nodes is a rule, not a suggestion.* Node ids exist only where an edge
mentions them, so 10,000 nodes and 500 edges is a 500-node graph and a summary
that contradicts the request. Refusing it is the honest answer; silently
clamping either number would be a graph nobody asked for.

*The planted-partition generator left the app.* Two fields cannot express
`communities`/`pIntra`, and adding a third and fourth would be the preset list
again in a worse form. `clustered` remains in `bench/generate-fixtures.mjs`,
which is where the M3 layout-quality gate reads it from; the app's copy was
deleted rather than left unreachable. The cost is real and worth naming: you
can no longer produce a visibly clustered graph on a device with no files on
it, so a phone gets a hairball. Revisit by teaching the fields a shape rather
than by restoring the buttons.

The graph id is now `sample-<nodes>x<edges>`, so regenerating a size overwrites
in place (as regenerating a preset did) while two sizes stay two graphs. Names
are formatted without `toLocaleString` — a persisted name that depends on the
browser's locale would make the same request two different graphs.

**Revisit if:** a requested size gets big enough that BigInt generation becomes
the wait (then port the RNG and gate it with the same hash test), the fields
need to describe a *shape* as well as a size (clustered, bipartite, grid), or
the app grows a real-dataset importer, at which point "no data on this device"
stops being the problem this solves.

## D18 — On a phone the canvas is the app: the panel is a sheet, and touch can zoom

D17 put a graph on a phone for the first time, and the first screenshot back
from one showed two failures at once. The explore panel is a fixed 17rem
sidebar, which on a 390 px screen is 70% of the width, so the graph was a
sliver down the left edge; and the HUD wrapped to three rows on top of that.
Worse, the view could not be zoomed at all: pan came free with pointer events,
but zoom was a `wheel` handler and a touch screen never sends one.

**Decision:** below 48rem the canvas takes the whole body and the explore panel
becomes a bottom sheet, and pointer handling tracks a *set* of contacts so two
fingers pinch.

*Why a sheet rather than a narrower sidebar, or a tab switch.* Any width the
sidebar keeps is width the graph loses, permanently, in the layout the user
spends their time in. A sheet costs one 2.6rem handle when closed and is a
thumb away when wanted — and, because it overlays rather than displaces, the
canvas never resizes when it opens, so no camera state changes underneath it
(a tab switch would unmount the canvas and re-run the render effect, which on
this code path means re-fitting the view). A tap that selects a node raises the
sheet by itself: on a phone there is no hover, so the tap is the only way to
ask, and its whole answer would otherwise be off-screen.

*The breakpoint is duplicated, deliberately.* CSS owns the layout and
`GraphView` owns whether the handle exists at all (a docked panel must not
render a button to collapse itself), so `NARROW_QUERY` and the `@media` block
state the same 48rem. A single source would mean driving the layout from JS
state — a resize listener re-rendering the view that owns the GPU device.

*Pinch is a pointer-set gesture, not a touch-event handler.* The existing
handlers already spoke Pointer Events, so pinch is `pointers: Map<id, xy>`:
size 1 is the old drag, size 2 pans by the midpoint and zooms by the
separation, both anchored at the midpoint so the world stays under the fingers.
Two edges are the whole difference between working and infuriating, and both
are tested: a second finger poisons the tap (`travel = Infinity`) so ending a
pinch does not select whatever is under the last finger up, and lifting one of
two fingers re-seats the surviving one as the pan origin — without that the
camera jumps by the distance between them on the next move. Touch also gets a
fingertip's slack in both the pick radius (24 px vs 12) and the click threshold
(12 px vs 4), and hover picking is skipped for non-mouse pointers entirely.

*The zoom buttons are not a fallback for pinch.* Pinch works; the buttons make
zoom discoverable, give a one-thumb path, and — with *fit* beside them — are
the only way back from a view the user has panned off into empty space, which
is easy to do on a small screen and was previously unrecoverable without a
re-layout. They are shown at every width for the same reason.

`tests/mobile.spec.ts` gates all of it at 390×844 with touch: the canvas gets
>95% of the width, the sheet parks off the bottom and comes back, a CDP-driven
pinch moves `__skeinRender.zoom` (Playwright's touchscreen API is
single-contact and cannot express a pinch at all), and the buttons zoom and
fit. It also asserts the handle's *height*, which is not paranoia: as a flex
item in a column it was silently shrunk to zero the moment a selection
overflowed the sheet, taking the only way to close the panel with it.

**Revisit if:** the sheet wants a half-open detent (it is open/closed today,
and a long neighbour list scrolls inside it), the HUD's three narrow rows start
costing more than they inform, or the fit view needs to account for the sheet
covering the bottom of the canvas — today it frames the graph in the full
canvas and the sheet overlays the lower half of it.

## D19 — The test suite is the CI run; setup sharing and capture cost (2026-08-02)

**Question:** CI takes ~9m36s and it is getting in the way. Where does it go,
and what is worth changing?

**Measured first, on run 30743355359 (main, ubuntu-latest, 4 cores):**

| job | duration |
| --- | --- |
| `rust` | 57s |
| `native` (macOS) | 39s |
| `web` | **9m33s** |

and inside `web`: checkout + toolchain 16s, `npm ci` 5s, `npm run build` 14s,
fixtures 1s, Playwright install 20s, **`npm run test -w tests` 8m33s**. The
Playwright suite is 89% of the whole CI run. Nothing else is worth touching
until it moves, which is why the two cheap wins below are recorded as cheap.

A local baseline (same core count, SwiftShader, 2 workers) put the suite at
**1160.5s of test time / 614.6s wall**, distributed like this:

| spec | test time | share |
| --- | --- | --- |
| `attributes.spec.ts` | 555.1s | 48% |
| `explore.spec.ts` | 145.8s | 13% |
| `lod.spec.ts` | 143.8s | 12% |
| `no-network.spec.ts` (privacy) | 93.5s | 8% |
| `no-network.spec.ts` (cli) | 85.8s | 7% |
| `layout-fallback` / `layout` / `ingest` / `generate` | 136.6s | 12% |

**What the time actually is.** Solo, on an idle container: ingest + layout of
`tiny` is 4.3s, a DuckDB start is 9.4s, the attribute join 7.3s. Every one of
`attributes.spec.ts`'s seven tests paid all three, for one graph none of them
destroys. That is the first cost, and it is pure repetition.

The second is frames, and it is not where it looked. Two measurements killed
two plausible fixes before they were written:

- *`canvas.screenshot()` costs 6.4s against 2.5s for `page.screenshot({clip})`
  over the same box.* The element path first waits for the element to be
  **stable**, which it decides by diffing bounding boxes across animation
  frames — and this canvas is driven by a permanent rAF loop, so the check pays
  several frames every time. The clip captures the canvas's own bounding box:
  same pixels, and a legend appearing beside the canvas still cannot make the
  comparison pass. Adopted only after checking that two captures of an
  unchanged canvas are byte-identical and that colour-by still differs.
- *Frame cost does not scale with canvas pixels.* 6395ms for five styled frames
  at 1280x720, 6234ms at 640x480. Shrinking the test viewport — the obvious
  move for a renderer documented as fill-bound (D8) — buys nothing here,
  because at `tiny` under SwiftShader the styled path is vertex-bound, not
  fill-bound. Not done.

What the frame numbers *did* show is that **styling triples the cost of
everything**: an unstyled settle of five frames is 1817ms and a styled one
6395ms, an unstyled clip capture 4244ms and a styled one 14936ms, and a plain
`<details>` click 11627ms. That is D14's styled WebGL2 edge pass — instanced
endpoint *pairs*, because GL2 cannot reach the partner vertex's attribute —
landing on a software rasteriser. It is the price of the coverage, not a bug.

**Decisions.**

1. *Setup is shared where nothing destroys it.* The five `attributes` tests and
   three `explore` tests that only want "a laid-out `tiny`" run serially
   against one page built in `beforeAll`. Serial because they share state: a
   failure part way through leaves the page in a condition the rest cannot
   interpret, so skipping the remainder is the honest outcome.
2. *Three tests keep their own tab, deliberately.* The DuckDB-lazy test is only
   a test at all against a tab that has never opened the panel, and the two
   WebGL2 ones choose a backend before any script runs. Warming those would
   make them pass vacuously.
3. *Order inside a shared group is load-bearing.* The re-layout test and the
   close-and-reopen test sort last, because each replaces state the others
   assert against.
4. *`settle` waits two frames, not five.* Every caller already waits on the DOM
   for the state it asked for, so one full frame would do and the second is
   margin.
5. *The dead spike leaves the build.* `spike.html` was a production input, so
   597 kB of cosmos.gl — unimported since D7 — was bundled into every CI run
   and into the `web/dist` the binary embeds (D10). `SKEIN_SPIKE=1` restores
   it; the opt-in spike runs against the dev server and never needed it.
6. *The Playwright browser is cached* on the resolved `@playwright/test`
   version. Worth 20s, and recorded as 20s.

**Not done, and why.** The `cli` project re-runs the whole of
`no-network.spec.ts` against the binary, and its heavy first test is 85.8s of
duplicated app exercise — the app code is byte-identical to the `privacy`
project's. Only some of it is binary-specific (COOP/COEP, the CSP, and whether
every brotli-embedded asset including the 35 MB DuckDB wasm actually serves).
Trimming it to that would be worth ~7% of the suite, but §7 is a stated
non-negotiable and "extend it whenever the app grows a new code path" is the
standing instruction, so narrowing it is a call to make deliberately rather
than as a performance edit.

Worth knowing before making it: **CI has no WebGPU**, so under SwiftShader the
`WebGL2 fallback` tests and their WebGPU-path counterparts exercise the same
backend. Those pairs are near-duplicates in CI and only diverge on real
hardware (D3).

**Result**, same machine and worker count as the baseline above, 25/25 passing:

| | test time | wall |
| --- | --- | --- |
| baseline | 1160.5s | 614.6s |
| shared setup + `settle` at two frames | 963.6s | 533.9s |
| + CDP capture | **899.4s** | **499.2s** |

—22.5% of test time, —19% of wall. By spec: `attributes.spec.ts` 555.1s ->
338.1s (—39%), `explore.spec.ts` 145.8s -> 102.8s (—29%), everything untouched
within ±4%, which is this container's noise. Dropping the spike entry also took
~700 kB out of `web/dist` (cosmos.gl plus luma.gl's WebGL device) and the vite
step from 4.50s to 2.65s.

Scaled onto the CI numbers this section opened with, the `web` job's test step
should go from 8m33s to roughly 6m55s and the run from 9m36s to about 7m50s.
That is the honest ceiling for this pass: what remains is `lod` (146s, inherent
— `small` is the smallest fixture where the draw budget is observable at all),
the two `no-network` runs (173s across both projects), and nine styled captures
that are irreducibly ~3s each until CI has a GPU.

**Revisit if:** the suite grows another DuckDB-dependent spec (share the group
rather than adding an eighth cold start), someone proposes an fps-driven or
viewport-driven speedup (both measured, both buy nothing — see above), or CI
gains a GPU runner, at which point the styled-frame cost that dominates
`attributes.spec.ts` disappears and this apportionment is stale.
