# skein

A fully client-side, open source viewer for large network graphs. Upload an
edge list, get an interactive force-directed layout. Your data never leaves
the tab — enforced by CSP and an automated no-network test, not by promise.

![skein: dropping a CSV edge list, the multilevel layout separating planted
communities, then pan and zoom](docs/demo.gif)

Unedited screen capture: a 20k-node / 120k-edge edge list ingested in 31 ms,
laid out in 1.9 s, and panned and zoomed at 60 fps — on the reference M3
MacBook Air, WebGPU on Metal. Recorded by `node tests/manual-demo.mjs`.

**Status: M4 done, plus distribution.** Ingest, rendering, deterministic
multilevel layout, and the explore surface — hover, selection, 1-hop
neighbourhoods, id search, and attribute-driven colour, size and filters — all
land at the 1M-node / 10M-edge tier, and the app ships as a single binary. M5
(compatibility matrix, docs, static deploy) is what is left. See
[REQUIREMENTS.md](REQUIREMENTS.md) for the full brief and
[docs/DECISIONS.md](docs/DECISIONS.md) for resolved design questions.

## Install

Prebuilt binaries for macOS, Linux, and Windows are attached to each
[GitHub Release](https://github.com/diegoglozano/skein/releases) by [dist],
with shell and PowerShell installers:

```sh
# Shell (Linux/macOS) — downloads the right prebuilt binary
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/diegoglozano/skein/releases/latest/download/skein-installer.sh | sh

# Windows (PowerShell)
powershell -c "irm https://github.com/diegoglozano/skein/releases/latest/download/skein-installer.ps1 | iex"
```

Both place the binary in `$CARGO_HOME/bin` (`~/.cargo/bin` by default).

`cargo install skein` is **not** supported: the web bundle is built by npm and
baked into the binary at compile time, so a crates.io source build would produce
a binary with no app inside it (docs/DECISIONS.md D10). To build from a checkout
you need Node, the Rust toolchain, and [wasm-pack]:

```sh
cargo install wasm-pack           # once; the web build compiles skein-wasm
npm install && npm run build      # must precede the cargo build
cargo build --release -p skein    # ./target/release/skein
```

[dist]: https://opensource.axo.dev/cargo-dist/
[wasm-pack]: https://rustwasm.github.io/wasm-pack/

## Run it

skein is a browser app. The `skein` binary carries the whole app inside it and
serves it to your own browser — there is no server, and nothing is uploaded.

```sh
skein            # serves http://127.0.0.1:7373 and opens a browser
skein --help     # --host, --port, --web-root, --fixtures, --no-open, --threads
```

The port is fixed on purpose — graphs you ingest are stored in the browser per
origin, and the origin includes the port, so a different port hides them.

### What to feed it

Drop a **CSV edge list** on the page (or use the file picker). Today the column
mapping is fixed: a header row is expected and skipped, the first column is the
source node, the second is the target. Anything further right is ignored, and
rows with fewer than two columns are skipped and counted in the summary.

```csv
source,target
alice,bob
alice,carol
```

**Nothing to feed it?** Under the drop zone are four sizes — `tiny` (10k/50k),
`clustered` (20k/120k, planted communities), `small` (100k/500k) and `medium`
(1M/10M, desktop-class) — and picking one *generates* that graph in the tab and
imports it like any file. Nothing is downloaded; the edges are synthesized on
your device, which is the only way to hand you a sample without breaking the
promise in the badge. They are the same graphs `bench/generate-fixtures.mjs`
writes, edge for edge, so a screenshot or a timing of `small` means the same
thing whichever side produced it (docs/DECISIONS.md D16). This is how to try
skein on a phone.

IDs are arbitrary strings; they're interned, so numeric and textual IDs both
work. The graph is parsed to CSR and persisted to OPFS in your browser, which is
why it shows up in the recent-graphs list on the next visit — and why clearing
site data for the origin deletes it.

### Attributes

Attach a second CSV — node ids in one column, anything else alongside — and the
sidebar can colour, size and filter by any of it. The join is reported honestly:
how many nodes matched, how many rows matched nothing, how many duplicate keys
were dropped. Without a second file you can still colour, size and filter by
degree, which the graph already knows.

This runs on DuckDB-WASM, and it is **not loaded until you open the panel** —
it is a 5 MB one-time download, served from this origin like everything else,
never from a CDN. The no-network test drives the whole attributes path, so that
is enforced rather than intended (docs/DECISIONS.md D14).

Colour uses three categorical hues and groups everything else into one neutral.
That looks stingy and is deliberate: on a near-black canvas where any two
categories can end up as neighbouring pixels, a fourth hue measurably stops
being distinguishable — including for readers with full colour vision (D14a).
Filter to compare the rest.

Current limits, all deliberate and all on the roadmap: CSV only (Parquet/Arrow
and a column-mapping dialog are §10), and the canvas draws a seeded 300k-edge
sample of larger graphs because edge rendering is fill-bound
(docs/DECISIONS.md D8) — the HUD says when it is sampling.

### Self-hosting

```sh
docker build -t skein .
docker run --rm -p 7373:7373 skein
```

**Serve it over HTTPS.** WebGPU and SharedArrayBuffer are only available in a
secure context (TLS, or localhost). Reached over plain HTTP at a LAN address the
app still loads, but falls back to the WebGL2 renderer and the CPU layout with
no visible error. Put it behind a TLS-terminating proxy.

To include a downloadable sample graph at `/fixtures/`, pass a preset from
`bench/generate-fixtures.mjs`:

```sh
docker build --build-arg SAMPLE_FIXTURE=small -t skein .
```

## Performance

Measured 2026-07-31 on the reference laptop (M3 MacBook Air, headed Chromium,
WebGPU on Metal) — real hardware, because headless CI runs on SwiftShader and its
numbers mean nothing here (docs/DECISIONS.md D3, D5). Raw JSON and screenshots
are in `bench/results/`.

| 1M nodes / 10M edges (152 MB CSV) | measured | §9 budget |
|---|---|---|
| Ingest — parse, CSR, persist to OPFS | 2.0 s | < 60 s |
| Layout — hierarchy + GPU force sim | 10.9 s | < 45 s |
| Pan/zoom after layout | 56 fps min | ≥ 30 fps |

A clustered 20k/120k graph lays out in 1.9 s at a steady 60 fps with planted
communities visibly separated — the qualitative gate for layout quality.

Same file + same seed + same machine + same browser produces the same picture;
that determinism is end-to-end tested across fresh browser contexts
(`tests/layout.spec.ts`), and scoped to a machine on purpose (D2).

## Repo layout

```
crates/skein-core/   Rust: ID interning, CSV scanner, CSR, coarsening — tested natively
crates/skein-wasm/   wasm-bindgen boundary (thin; algorithms stay in core)
crates/skein-cli/    the `skein` binary: embeds web/dist and serves it
web/src/workers/     ingest worker: File.stream() → WASM → CSR + OPFS
web/src/render/      WebGPU renderer with a WebGL2 fallback, shared flat buffers
web/src/layout/      multilevel force sim: WGSL compute, plus a CPU reference
web/src/ui/          React shell: drop zone, recent graphs, GraphView + HUD
bench/               fixture generator, native micro-benchmarks, dated results
tests/               Playwright specs and the manual real-hardware harnesses
```

`web/spike.html` is the M0 renderer spike, kept for reproducibility.

## Develop

wasm-pack is required — `npm run dev` and `npm run build` both compile
`skein-wasm` into `web/src/wasm-pkg` first, and the app will not start without it.

```sh
cargo install wasm-pack     # once
npm install                 # web + tests workspaces
npm run fixtures            # generate tiny + small synthetic graphs (gitignored)
npm run dev                 # app at :5173, spike at /spike.html?fixture=tiny
```

Before pushing:

```sh
cargo test --workspace
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
npm run build               # typecheck + production build (CSP injected here)
npm run test -w tests       # Playwright; needs fixtures + the build above
```

The Playwright suite runs four projects: `privacy` (the no-network gate against
the production build), `app` (ingest and layout determinism), `spike` (the M0
measurement, against the dev server), and `cli` (the same privacy gate against
the `skein` binary, which is a second deployment path with its own headers).
The `cli` project builds the binary, so a cold run is slow.

Fixtures live in `bench/fixtures/` and are served at `/fixtures/*` by a Vite
plugin — they are generated, never committed, and must not move into
`web/public/`.

In managed or remote environments, point Playwright at the pre-installed browser
with `CHROMIUM_PATH`, set to whatever `ls /opt/pw-browsers` reports — e.g.
`CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. That
Chromium is software-rendered (SwiftShader), so functional runs are fine there
but performance verdicts are not.

## Benchmarks

Native micro-benchmarks, compared as ratios so they survive machine differences:

```sh
cargo run --release --example bench | node bench/compare-bench.mjs
```

It flags a >20% regression against `bench/baselines/native-bench.json`. CI runs
it `--warn-only` for now: the committed baseline is machine-class specific and
has not been regenerated on the CI runner class, so a hard failure there would
mostly measure the runner. Refresh the baseline only deliberately, with
`--update` (D5).

Anything about frames or GPU time has to come from real hardware, via the manual
harnesses in `tests/` — each writes a dated JSON (plus a screenshot where it
helps) into `bench/results/`. They drive an already-running server rather than
starting one, and the render and layout harnesses launch **headed** on purpose:

```sh
node bench/generate-fixtures.mjs medium clustered   # medium is 1M/10M, ~30 s
npm run build
npm run preview -w web -- --port 4173 --strictPort  # leave running

node tests/manual-ingest.mjs medium.csv     # ingest stage timings
node tests/manual-render.mjs medium.csv     # fps under scripted pan/zoom
node tests/manual-layout.mjs medium.csv     # layout wall time + post-layout fps
```

`manual-layout.mjs` defaults to `clustered.csv`, the 20k/120k planted-community
fixture used as the visual quality gate. The M0 cosmos.gl comparison (D3) is
`node tests/manual-spike.mjs medium`, which wants the dev server on :5173
instead.

`tests/tune-layout.mjs` is the fast CPU calibration harness for force parameters —
use it before touching them; it prints cluster-separation metrics without a GPU.

`tests/manual-demo.mjs` re-records the GIF at the top of this file, driving the
same preview server headed so the capture shows the real WebGPU path. It needs
`ffmpeg`, and uses `gifsicle` if present for a lossy pass that costs little
visible quality and about a third of the file size:

```sh
node tests/manual-demo.mjs clustered.csv   # → docs/demo.gif
```

## Releasing

Packaging is [dist], configured in `dist-workspace.toml` plus `[profile.dist]`
in the root `Cargo.toml` — dist always builds `--profile dist`, so removing that
section breaks every release build.

Dry-run the exact command CI runs before tagging; it catches config mistakes in
a minute instead of six failed jobs:

```sh
npm run build                                          # dist does not do this for you
dist build --tag=v0.1.0 --artifacts=local --target=aarch64-apple-darwin
dist build --tag=v0.1.0 --artifacts=global             # the installers
```

Then bump the version in `crates/skein-cli/Cargo.toml`, tag, and push:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` builds every target, runs the web build first via
`.github/workflows/build-setup.yml` so the binary actually contains the app, and
creates the GitHub Release with the installers attached. After changing
`dist-workspace.toml`, run `dist generate` and commit the regenerated workflow.

If a release fails before the `host` job, no GitHub Release is created and the
tag can be reused: `git push origin :refs/tags/vX.Y.Z`, delete it locally, fix,
and re-tag.

## License

Apache-2.0.
