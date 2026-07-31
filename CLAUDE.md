# CLAUDE.md

Orientation for a fresh session. Read REQUIREMENTS.md top to bottom before
writing code — it is the brief. docs/DECISIONS.md records resolved design
questions (D1–D7); don't relitigate them without new evidence.

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
- **M1 — next up:** streaming CSV parse in WASM, batch ingest entry points on
  `skein-wasm::IngestSession` (the per-edge path is a placeholder), ingest
  worker, OPFS persistence, ingest benchmarks in CI.
- **M2–M5:** not started; see §11. M2/M3 are our own renderer + multilevel
  GPU layout per D7, not cosmos.gl integration.

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
