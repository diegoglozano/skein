# CLAUDE.md

Orientation for a fresh session. Read REQUIREMENTS.md top to bottom before
writing code — it is the brief. docs/DECISIONS.md records resolved design
questions (D1–D6); don't relitigate them without new evidence.

## Roadmap and current status

The roadmap is REQUIREMENTS.md §11 (M0–M5). Status as of 2026-07-31:

- **Done — scaffold (pre-M0):** repo layout per §12; `skein-core` interner +
  CSR builder (tested, benchmarked: ~3.1M interns/s, 10M-edge CSR in ~0.2s on
  a dev container); `skein-wasm` boundary compiles for wasm32; web shell with
  privacy badge + build-time CSP; deterministic fixture generator; Playwright
  no-network privacy gate (passing); CI (fmt/clippy/tests/wasm32/bench-ratio +
  build/privacy/spike).
- **M0 — in progress, blocked on real hardware.** The cosmos.gl spike
  (`web/spike.html` + `tests/spike.spec.ts`) runs end-to-end; a functional
  SwiftShader run is recorded in `bench/results/`. The wrap-vs-build verdict
  needs the 1M/10M run on the reference laptop, judged against DECISIONS.md
  D3 thresholds:
  `SPIKE_FIXTURE=medium npm run spike -w tests` (after
  `node bench/generate-fixtures.mjs medium`). **Do not start M2/M3 renderer or
  layout work before this verdict exists.**
- **M1 — next up, can proceed in parallel with the M0 verdict:** streaming CSV
  parse in WASM, batch ingest entry points on `skein-wasm::IngestSession`
  (the per-edge path is a placeholder), ingest worker, OPFS persistence,
  ingest benchmarks in CI.
- **M2–M5:** not started; see §11.

Relevant M0 facts already learned: cosmos.gl 3.4 is luma.gl 9 on the WebGL2
adapter (no WebGPU today, plausible migration path); it exposes `randomSeed`
(helps D2 determinism); its API takes flat typed arrays throughout.

## Commands

```sh
npm install                      # web + tests workspaces
cargo test --workspace           # core tests
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
npm run fixtures                 # tiny + small fixtures (gitignored, required for tests)
npm run dev                      # app :5173, spike at /spike.html?fixture=tiny
npm run build -w web             # typecheck + production build (CSP injected here only)
npm run test -w tests            # privacy gate + spike (needs fixtures + built web)
cargo run --release --example bench | node bench/compare-bench.mjs   # ratio gate
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
