# skein

A fully client-side, open source viewer for large network graphs. Upload an
edge list, get an interactive force-directed layout. Your data never leaves
the tab — enforced by CSP and an automated no-network test, not by promise.

**Status: M3 done** — ingest, rendering, and deterministic multilevel layout all
land at the 1M-node / 10M-edge tier. M4 (attributes, filters, search) is next.
See [REQUIREMENTS.md](REQUIREMENTS.md) for the full brief and
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
a binary with no app inside it (docs/DECISIONS.md D10). To build from a checkout:

```sh
npm install && npm run build    # must precede the cargo build
cargo build --release -p skein  # ./target/release/skein
```

[dist]: https://opensource.axo.dev/cargo-dist/

## Run it

skein is a browser app. The `skein` binary carries the whole app inside it and
serves it to your own browser — there is no server, and nothing is uploaded.

```sh
skein            # serves http://127.0.0.1:7373 and opens a browser
```

The port is fixed on purpose — graphs you ingest are stored in the browser per
origin, and the origin includes the port, so a different port hides them.

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

## Layout

```
crates/skein-core/   Rust: ID interning, CSR, coarsening — tested natively
crates/skein-wasm/   wasm-bindgen boundary
crates/skein-cli/    the `skein` binary: embeds web/dist and serves it
web/                 React + Vite app; spike.html is the M0 renderer spike
bench/               fixture generator, native micro-benchmarks, results
tests/               Playwright: the no-network privacy gate + spike runner
```

## Develop

```sh
npm install                 # web + tests workspaces
cargo test --workspace      # core data structures
npm run fixtures            # generate tiny + small synthetic graphs
npm run dev                 # app at :5173, spike at /spike.html?fixture=tiny
```

## M0 spike

```sh
node bench/generate-fixtures.mjs medium     # 1M nodes / 10M edges (~30s, ~200MB)
npm run build -w web
SPIKE_FIXTURE=medium npm run spike -w tests # writes bench/results/spike-*.json
```

The wrap-vs-build pass criteria are in docs/DECISIONS.md D3. Only runs on real
hardware count — headless CI uses SwiftShader (software GL).

## Benchmarks

```sh
cargo run --release --example bench | node bench/compare-bench.mjs
```

CI fails on a >20% regression against `bench/baselines/native-bench.json`.

## Releasing

Packaging is [dist], configured in `dist-workspace.toml`. Bump the version in
`crates/skein-cli/Cargo.toml`, then tag and push:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` builds every target, runs the web build first via
`.github/workflows/build-setup.yml` so the binary actually contains the app, and
creates the GitHub Release with the installers attached. After changing
`dist-workspace.toml`, run `dist generate` and commit the regenerated workflow.

## License

Apache-2.0.
