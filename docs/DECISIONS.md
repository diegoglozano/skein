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
