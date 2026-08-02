//! Native multilevel layout, run off the render thread (D13/N1).
//!
//! The algorithm is entirely `skein_core::layout` — the same code the browser's
//! no-WebGPU tier runs through WASM (D11). Nothing is reimplemented here; this
//! module is the native equivalent of the ingest worker: it owns a thread,
//! steps the sim in chunks, and publishes progress and position snapshots.
//!
//! Two things differ from the WASM tier, and both are the point of going
//! native. There is no `max_sim_nodes` cap: D11 set the browser's to 1M because
//! larger levels blew the §9 wall-clock budget, whereas here every level gets a
//! real sim. And the position snapshots are moved, not copied across a boundary
//! — an 8 MB `Vec<f32>` at 1M nodes costs a pointer to hand over.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::thread;
use std::time::Instant;

use skein_core::{build_hierarchy_view, LayoutProgress, MultilevelLayout, SimParams};

use crate::gpu_layout::GpuMultilevel;
use crate::store::Store;

/// Which force engine ran, for the status line and the benchmark record.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    /// WGSL compute via wgpu — the port of gpu.ts.
    Gpu,
    /// `skein_core::MultilevelLayout` — same code the browser's no-WebGPU tier
    /// runs through WASM.
    Cpu,
}

impl Engine {
    pub fn label(self) -> &'static str {
        match self {
            Engine::Gpu => "gpu",
            Engine::Cpu => "cpu",
        }
    }
}

/// Uniform interface over the two engines so the driver loop is written once.
enum Sim {
    Gpu(Box<GpuMultilevel>),
    Cpu(Box<MultilevelLayout>),
}

impl Sim {
    fn step(&mut self, budget: u32) -> bool {
        match self {
            Sim::Gpu(s) => s.step(budget),
            Sim::Cpu(s) => s.step(budget),
        }
    }

    fn progress(&self) -> LayoutProgress {
        match self {
            Sim::Gpu(s) => s.progress(),
            Sim::Cpu(s) => s.progress(),
        }
    }

    fn positions(&self) -> Vec<f32> {
        match self {
            Sim::Gpu(s) => s.read_positions(),
            Sim::Cpu(s) => s.positions().to_vec(),
        }
    }

    fn at_finest(&self) -> bool {
        match self {
            Sim::Gpu(s) => s.at_finest(),
            Sim::Cpu(s) => {
                let p = s.progress();
                p.level == p.levels
            }
        }
    }
}

/// Force iterations per chunk between progress publications. Small enough that
/// cancellation is responsive, large enough that the channel is not the
/// bottleneck.
const STEP_BUDGET: u32 = 8;

/// Levels coarser than the finest have fewer nodes, so their positions cannot
/// be handed to a renderer sized for the finest level. Preview cadence in
/// iterations, applied only at the finest level.
const PREVIEW_EVERY: u32 = 24;

pub enum LayoutMsg {
    /// Coarsening finished; the sim is about to start.
    Hierarchy {
        levels: usize,
        secs: f64,
        engine: Engine,
    },
    Progress {
        level: u32,
        levels: u32,
        iter: u32,
        iters: u32,
        nodes: u32,
        /// Present only at the finest level, on preview ticks.
        positions: Option<Vec<f32>>,
    },
    Done {
        positions: Vec<f32>,
        /// Wall time for the whole run, hierarchy included — the number that
        /// compares against §9's 45 s budget and the browser's ~11 s.
        secs: f64,
        hierarchy_secs: f64,
    },
}

pub struct LayoutHandle {
    pub rx: Receiver<LayoutMsg>,
    cancel: Arc<AtomicBool>,
}

impl LayoutHandle {
    /// Ask the thread to stop at the next chunk boundary. The thread owns its
    /// data, so dropping the handle without this simply detaches it.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

impl Drop for LayoutHandle {
    fn drop(&mut self) {
        self.cancel();
    }
}

/// Start a layout. `csr` is the directed CSR as ingested; coarsening
/// symmetrizes it internally, exactly as `LayoutSession` does in WASM.
///
/// `gpu` selects the engine. When present the WGSL compute sim runs on that
/// device — which is the *renderer's* device, so positions never leave the
/// GPU's memory space. Absent, the CPU engine runs, which is the fallback and
/// also what `--cpu-layout` forces for A/B measurement.
pub fn spawn(
    store: Arc<Store>,
    seed: u32,
    target_nodes: u32,
    max_levels: usize,
    gpu: Option<(wgpu::Device, wgpu::Queue)>,
) -> LayoutHandle {
    let (tx, rx) = mpsc::channel();
    let cancel = Arc::new(AtomicBool::new(false));
    let thread_cancel = cancel.clone();

    thread::Builder::new()
        .name("skein-layout".into())
        .spawn(move || {
            let started = Instant::now();

            let t0 = Instant::now();
            // Coarsens directly out of the mapping — the finest level is the
            // only one that reads the input, and it reads it borrowed (D13/N2).
            let levels = build_hierarchy_view(store.csr(), target_nodes, max_levels);
            let hierarchy_secs = t0.elapsed().as_secs_f64();
            let level_count = levels.len();
            // The mapping stays open for the renderer; the pages this touched
            // are reclaimable by the OS from here on.
            drop(store);
            let engine = if gpu.is_some() {
                Engine::Gpu
            } else {
                Engine::Cpu
            };
            if tx
                .send(LayoutMsg::Hierarchy {
                    levels: level_count,
                    secs: hierarchy_secs,
                    engine,
                })
                .is_err()
            {
                return;
            }

            // No sim cap on either engine: every level gets refined, unlike
            // D11's WASM tier which caps at 1M nodes to hold the §9 budget.
            let mut layout = match gpu {
                Some((device, queue)) => Sim::Gpu(Box::new(GpuMultilevel::new(
                    device,
                    queue,
                    levels,
                    seed,
                    SimParams::default(),
                ))),
                None => Sim::Cpu(Box::new(MultilevelLayout::new(
                    levels,
                    seed,
                    SimParams::default(),
                    usize::MAX,
                ))),
            };

            let mut since_preview = 0u32;
            loop {
                if thread_cancel.load(Ordering::Relaxed) {
                    return;
                }
                let finished = layout.step(STEP_BUDGET);
                let p = layout.progress();
                since_preview += STEP_BUDGET;

                if finished {
                    let _ = tx.send(LayoutMsg::Done {
                        positions: layout.positions(),
                        secs: started.elapsed().as_secs_f64(),
                        hierarchy_secs,
                    });
                    return;
                }

                // Preview only the finest level: coarser ones have a different
                // node count and the renderer would reject them anyway. On the
                // GPU engine this is also the only place that blocks on a
                // readback, so keeping it rare matters.
                let positions = if layout.at_finest() && since_preview >= PREVIEW_EVERY {
                    since_preview = 0;
                    Some(layout.positions())
                } else {
                    None
                };

                if tx
                    .send(LayoutMsg::Progress {
                        level: p.level,
                        levels: p.levels,
                        iter: p.iter,
                        iters: p.iters,
                        nodes: p.nodes,
                        positions,
                    })
                    .is_err()
                {
                    return; // receiver gone
                }
            }
        })
        .expect("spawn layout thread");

    LayoutHandle { rx, cancel }
}
