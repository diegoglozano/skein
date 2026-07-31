# skein

A fully client-side, open source viewer for large network graphs. Upload an
edge list, get an interactive force-directed layout. Your data never leaves
the tab — enforced by CSP and an automated no-network test, not by promise.

**Status: pre-M0.** Scaffold + the cosmos.gl evaluation spike. See
[REQUIREMENTS.md](REQUIREMENTS.md) for the full brief and
[docs/DECISIONS.md](docs/DECISIONS.md) for resolved design questions.

## Layout

```
crates/skein-core/   Rust: ID interning, CSR, (later) coarsening — tested natively
crates/skein-wasm/   wasm-bindgen boundary
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

## License

Apache-2.0.
