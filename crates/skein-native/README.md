# skein-native

The macOS front end with no browser in it (docs/DECISIONS.md D15). A winit
window, a wgpu surface on Metal, and `skein-core` — no webview, no WASM, no
JavaScript.

**This is a second front end, not a replacement.** The web app is the primary
artifact and is untouched by everything here. This exists for graphs the browser
cannot open at all: §8's 4 GB wasm linear-memory cap is a hard ceiling, and a
100M-edge CSR is well past it. Both front ends share `skein-core`, read the same
fixtures, and produce the same layouts.

## What is shared and what is ported

`skein-core` is used unchanged — CSV ingest, interning, CSR, coarsening, the CPU
force engine. Two things are ported from the web tier rather than shared,
because they cannot be: `shader.wgsl` and `shader_layout.wgsl` are **verbatim
copies** of the WGSL in `web/src/render/webgpu.ts` and `web/src/layout/gpu.ts`.
Diff them before debugging a visual difference — a divergence means the wgpu
pipeline setup is wrong, not the shader. `shader_layout.wgsl`'s `const` prelude
is *generated* in `gpu_layout.rs` from `skein-core`'s constants, so that half
cannot drift at all.

`camera.rs` is a port of `web/src/render/camera.ts`, kept structurally identical
so both front ends frame a graph the same way.

## Layout

The force sim runs on the **renderer's own device**, cloned into the layout
thread, so positions live in one GPU allocation that both the compute and vertex
stages address — no readback on the hot path. `--cpu-layout` forces
`skein-core`'s engine instead, which is the A/B that showed the GPU one is 3.7×
faster.

Sharing a device is also what makes the sim and the renderer competitors for it.
The D8 edge cap is applied by default here for that reason as well as the
fill-rate one: without it a 1M/10M layout took 513 s instead of 6.6 s, because
an uncapped 10M-edge draw starved the compute queue. The shader was never the
problem.

**The draw budget is behind the web tier.** D13/D13a replaced the fixed cap in
the browser with one that follows the camera, and measured a collapse from 57
to 7.8 fps when zooming out past the fit view — drawn counts unchanged, fill
doing all the damage. 300k here matches the web's `maxEdges` ceiling, so the fit
view draws exactly what the browser draws, but nothing scales it down past fit
and this renderer will hit that trough. Porting `web/src/render/lod.ts` is the
fix; it wants the pick grid's cell prefix sums, which this crate does not have.

## Store

`store.rs` persists the CSR in its exact in-memory layout beside the source as
`<source>.skein` and memory-maps it on open, so reopening costs an `mmap` and
two slice casts rather than a parse. `skein-core`'s `CsrView` /
`build_hierarchy_view` let the hierarchy coarsen straight out of the mapping.

The renderer never expands every edge. `sample_edge_indices` picks the drawn
sample with a partial Fisher–Yates over a *virtual* identity array — O(k) in
time and memory regardless of graph size — so a 300k-edge sample of a 100M-edge
graph costs 2.4 MB and ~90 ms rather than 800 MB and 1.5 s.

## No UI

Deliberately. The full egui port of `GraphView.tsx` was dropped when N0 measured
the render path as no faster than the browser's (D15): the case for going native
is capacity and layout speed, neither of which is improved by drawing the
sidebar in egui rather than HTML. What exists is pan, zoom, a title-bar HUD, and
CLI flags. Treat missing UI as a decision, not an omission.

## Usage

```sh
cargo run -p skein-native --release -- <edges.csv>            # open, lay out, explore
cargo run -p skein-native --release -- <edges.csv> --sweep    # edge-cap fps sweep
```

| flag | effect |
|---|---|
| `--seed N` | layout seed (D2: same file + seed ⇒ same picture) |
| `--edges N` | raise or lower the drawn-edge sample (default 300k, D8) |
| `--cpu-layout` | use `skein-core`'s CPU engine instead of the WGSL one |
| `--no-layout` | skip layout; seeded scatter only |
| `--no-store` | ignore and do not write `<source>.skein` |
| `--sweep` | scripted pan, fps per edge count, vsync off |
| `--serialize` | block on the GPU each frame — measures render cost, not queue depth |
| `--exit-after-layout` | clean exit, so `/usr/bin/time -l` attributes peak RSS to one run |

## Measuring

Numbers only count from a headed run on real hardware (D3/D5), and a window that
is occluded or unfocused measures the compositor rather than the renderer —
`render()` returns whether it actually presented, and the sweep reports frames
the surface refused. Ignoring that once produced a confident 64,867 fps at 10M
edges. `--serialize` exists because vsync-off swapchain queueing otherwise
reports frame times that describe queue occupancy.

`position_stats` prints extent, centroid and a non-finite count after every
layout and flags `** COLLAPSED **` / `** NON-FINITE **`, because a wrong compute
shader is characteristically *fast* and wrong.

Reference numbers (M3 Air, headed, docs/DECISIONS.md D15): `medium` 1M/10M lays
out in 5.8 s against the browser's ~11 s; `huge` 10M/100M ingests in 29 s and
lays out in 89 s, or opens in 0.95 s from a warm store.
