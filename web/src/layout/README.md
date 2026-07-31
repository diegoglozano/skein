# layout/

Multilevel layout (M3): coarsening hierarchy from skein-wasm, force sim per
REQUIREMENTS.md §6. Deterministic per docs/DECISIONS.md D2.

Only the WebGPU tier lives here — the WGSL compute engine (`gpu.ts`) and the
main-thread orchestration it needs (`multilevel.ts`), because the WebGPU device
is main-thread-owned. The algorithm itself, and the whole no-WebGPU tier, live
in `crates/skein-core/src/layout.rs` and run in the worker via WASM
(docs/DECISIONS.md D11). `params.ts` holds the constants and schedule both
engines share; it must stay in step with the Rust module.
