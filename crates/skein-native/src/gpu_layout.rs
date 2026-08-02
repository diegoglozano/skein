//! wgpu compute force sim — the native port of web/src/layout/gpu.ts (D15/N1).
//!
//! The shader is `shader_layout.wgsl`, copied verbatim from the TS engine; the
//! `const` prelude is generated here from `skein_core`'s constants so the two
//! cannot drift. The multilevel driver mirrors `skein_core::MultilevelLayout`'s
//! level and iteration scheme exactly (coarsest gets `COARSEST_ITERS`, budgets
//! halve per finer level, floor `MIN_ITERS`), because a layout that used a
//! different schedule would not be comparable to either existing engine.
//!
//! Why this exists at all: `skein_core`'s `LevelSim` is the CPU engine, and
//! measured natively it lays out 1M/10M in 19.2 s against the browser's ~11 s
//! on its WebGPU tier. The browser is not faster because it is a browser — it
//! is faster because it runs *this* shader on the GPU while the native build
//! was running the CPU one. `skein-core` cannot host it: it must stay
//! wasm-compatible and dependency-light, so wgpu lives here, exactly as the
//! WGSL engine lives in TypeScript on the web side.

use skein_core::{
    prolongate_positions, seed_disc_positions, HierarchyLevel, LayoutProgress, LevelSchedule,
    SimParams, COARSEST_ITERS, GRID, GRID2, MIN_ITERS, WORLD_SIZE,
};
use wgpu::util::DeviceExt;

/// Fixed-point scale for fine-cell-relative coordinates. Mirrors `FIXED_SCALE`
/// in params.ts: |rel| ≤ CELL/2 = 16 world units → ≤1024 scaled, so ~2M nodes
/// per cell before i32 overflow. GPU-only — the CPU engine sums in f64 and has
/// no equivalent constant.
const FIXED_SCALE: f32 = 64.0;
/// Coarse cells are 256 world units, so |rel| ≤ 128 → ≤1024 scaled at 8.
const FIXED_SCALE2: f32 = 8.0;

const WORKGROUP: u32 = 256;

fn shader_source() -> String {
    let cell = WORLD_SIZE / GRID as f32;
    let cell2 = WORLD_SIZE / GRID2 as f32;
    format!(
        "const WORLD: f32 = {world:?};\n\
         const GRID: i32 = {grid};\n\
         const CELL: f32 = {cell:?};\n\
         const SCALE: f32 = {scale:?};\n\
         const CELLS: u32 = {cells}u;\n\
         const GRID2: i32 = {grid2};\n\
         const CELL2: f32 = {cell2:?};\n\
         const SCALE2: f32 = {scale2:?};\n\
         const CELLS2: u32 = {cells2}u;\n\
         const FPC: i32 = {fpc};\n\
         {body}",
        world = WORLD_SIZE,
        grid = GRID,
        cell = cell,
        scale = FIXED_SCALE,
        cells = GRID * GRID,
        grid2 = GRID2,
        cell2 = cell2,
        scale2 = FIXED_SCALE2,
        cells2 = GRID2 * GRID2,
        fpc = GRID / GRID2,
        body = include_str!("shader_layout.wgsl"),
    )
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct GpuParams {
    n: u32,
    step: f32,
    a_scale: f32,
    r_scale: f32,
    gravity: f32,
    weight_cap: f32,
    _pad0: f32,
    _pad1: f32,
}

/// Compiled pipelines and layout, built once and reused across levels —
/// creating them per level would recompile the shader four times per run.
struct Programs {
    bind_group_layout: wgpu::BindGroupLayout,
    clear_grid: wgpu::ComputePipeline,
    aggregate: wgpu::ComputePipeline,
    reduce_root: wgpu::ComputePipeline,
    forces: wgpu::ComputePipeline,
}

impl Programs {
    fn new(device: &wgpu::Device) -> Programs {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("skein-layout"),
            source: wgpu::ShaderSource::Wgsl(shader_source().into()),
        });

        let entry = |binding: u32, read_only: bool| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("skein-layout-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                entry(1, true),  // posIn
                entry(2, false), // posOut
                entry(3, false), // fineGrid
                entry(4, false), // coarseGrid
                entry(5, true),  // offsets
                entry(6, true),  // targets
                entry(7, true),  // weights
                entry(8, false), // root
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("skein-layout-pl"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });
        let pipeline = |entry_point: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry_point),
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some(entry_point),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        Programs {
            clear_grid: pipeline("clearGrid"),
            aggregate: pipeline("aggregate"),
            reduce_root: pipeline("reduceRoot"),
            forces: pipeline("forces"),
            bind_group_layout,
        }
    }
}

/// One hierarchy level resident on the GPU.
struct LevelSim {
    n: u32,
    avg_deg: f64,
    params: SimParams,
    schedule: LevelSchedule,
    iters: u32,
    iter: u32,
    flip: bool,

    uniform: wgpu::Buffer,
    pos_a: wgpu::Buffer,
    pos_b: wgpu::Buffer,
    staging: wgpu::Buffer,
    bind_ab: wgpu::BindGroup,
    bind_ba: wgpu::BindGroup,
    // Kept alive for the bind groups' sake.
    _grids: [wgpu::Buffer; 2],
    _csr: [wgpu::Buffer; 3],
    _root: wgpu::Buffer,
}

impl LevelSim {
    #[allow(clippy::too_many_arguments)]
    fn new(
        device: &wgpu::Device,
        programs: &Programs,
        offsets: &[u32],
        targets: &[u32],
        weights: &[f32],
        positions: &[f32],
        params: SimParams,
        schedule: LevelSchedule,
        iters: u32,
    ) -> LevelSim {
        let n = (positions.len() / 2) as u32;
        let avg_deg = targets.len() as f64 / n.max(1) as f64;

        let storage = |label, bytes: &[u8], extra: wgpu::BufferUsages| {
            // Storage bindings must be non-empty; keep a 4-byte stub, as the
            // browser path does for edgeless levels.
            let stub = [0u8; 4];
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: if bytes.is_empty() { &stub } else { bytes },
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | extra,
            })
        };

        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("layout-params"),
            size: std::mem::size_of::<GpuParams>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let pos_bytes: &[u8] = bytemuck::cast_slice(positions);
        let pos_a = storage("posA", pos_bytes, wgpu::BufferUsages::COPY_SRC);
        let pos_b = storage("posB", pos_bytes, wgpu::BufferUsages::COPY_SRC);
        let fine_grid = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("fineGrid"),
            size: (4 * 3 * GRID * GRID) as u64,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let coarse_grid = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("coarseGrid"),
            size: (4 * 3 * GRID2 * GRID2) as u64,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let csr = [
            storage(
                "offsets",
                bytemuck::cast_slice(offsets),
                wgpu::BufferUsages::empty(),
            ),
            storage(
                "targets",
                bytemuck::cast_slice(targets),
                wgpu::BufferUsages::empty(),
            ),
            storage(
                "weights",
                bytemuck::cast_slice(weights),
                wgpu::BufferUsages::empty(),
            ),
        ];
        let root = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("root"),
            size: 16,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let staging = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("staging"),
            size: pos_bytes.len() as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        let bind = |pos_in: &wgpu::Buffer, pos_out: &wgpu::Buffer| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("skein-layout-bg"),
                layout: &programs.bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: uniform.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: pos_in.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: pos_out.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: fine_grid.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: coarse_grid.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 5,
                        resource: csr[0].as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 6,
                        resource: csr[1].as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 7,
                        resource: csr[2].as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 8,
                        resource: root.as_entire_binding(),
                    },
                ],
            })
        };
        let bind_ab = bind(&pos_a, &pos_b);
        let bind_ba = bind(&pos_b, &pos_a);

        LevelSim {
            n,
            avg_deg,
            params,
            schedule,
            iters,
            iter: 0,
            flip: false,
            uniform,
            pos_a,
            pos_b,
            staging,
            bind_ab,
            bind_ba,
            _grids: [fine_grid, coarse_grid],
            _csr: csr,
            _root: root,
        }
    }

    /// Enqueue one iteration. Does not wait for the GPU.
    fn step(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, programs: &Programs) {
        let step = self.schedule.step_at(self.iter, self.iters);
        self.iter += 1;
        let k_opt = self.schedule.k_opt;
        let params = GpuParams {
            n: self.n,
            step: step as f32,
            a_scale: (self.params.attraction_scale * self.avg_deg * k_opt) as f32,
            r_scale: (self.params.repulsion_scale * k_opt * k_opt) as f32,
            gravity: self.params.gravity as f32,
            weight_cap: self.params.weight_cap as f32,
            _pad0: 0.0,
            _pad1: 0.0,
        };
        queue.write_buffer(&self.uniform, 0, bytemuck::bytes_of(&params));

        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("layout-step"),
                timestamp_writes: None,
            });
            let bind = if self.flip {
                &self.bind_ba
            } else {
                &self.bind_ab
            };
            pass.set_bind_group(0, bind, &[]);
            pass.set_pipeline(&programs.clear_grid);
            pass.dispatch_workgroups(((3 * GRID * GRID) as u32).div_ceil(WORKGROUP), 1, 1);
            pass.set_pipeline(&programs.aggregate);
            pass.dispatch_workgroups(self.n.div_ceil(WORKGROUP), 1, 1);
            pass.set_pipeline(&programs.reduce_root);
            pass.dispatch_workgroups(1, 1, 1);
            pass.set_pipeline(&programs.forces);
            pass.dispatch_workgroups(self.n.div_ceil(WORKGROUP), 1, 1);
        }
        queue.submit(Some(encoder.finish()));
        self.flip = !self.flip;
    }

    fn current(&self) -> &wgpu::Buffer {
        if self.flip {
            &self.pos_b
        } else {
            &self.pos_a
        }
    }

    /// Copy positions back to the CPU. Blocks on the GPU, so call it on
    /// preview ticks and level boundaries, not every iteration.
    fn read(&self, device: &wgpu::Device, queue: &wgpu::Queue) -> Vec<f32> {
        let bytes = 8 * u64::from(self.n);
        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        encoder.copy_buffer_to_buffer(self.current(), 0, &self.staging, 0, bytes);
        queue.submit(Some(encoder.finish()));

        let slice = self.staging.slice(..bytes);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        let out = match rx.recv() {
            Ok(Ok(())) => match slice.get_mapped_range() {
                Ok(view) => bytemuck::cast_slice::<u8, f32>(&view).to_vec(),
                Err(e) => {
                    eprintln!("layout readback: mapped range unavailable: {e:?}");
                    vec![0.0; 2 * self.n as usize]
                }
            },
            other => {
                eprintln!("layout readback failed: {other:?}");
                vec![0.0; 2 * self.n as usize]
            }
        };
        self.staging.unmap();
        out
    }
}

/// Multilevel driver. Mirrors `skein_core::MultilevelLayout`'s scheme so the
/// three engines (WGSL-in-browser, CPU-in-core, this) stay comparable.
pub struct GpuMultilevel {
    device: wgpu::Device,
    queue: wgpu::Queue,
    programs: Programs,
    levels: Vec<HierarchyLevel>,
    seed: u32,
    params: SimParams,
    /// Index of the level being worked on; counts down to 0.
    li: usize,
    sim: Option<LevelSim>,
    /// Positions for the current level, on the CPU. Refreshed from the GPU at
    /// level boundaries (prolongation needs them) and on preview ticks.
    positions: Vec<f32>,
    iters: u32,
    iter: u32,
    done: bool,
}

impl GpuMultilevel {
    pub fn new(
        device: wgpu::Device,
        queue: wgpu::Queue,
        levels: Vec<HierarchyLevel>,
        seed: u32,
        params: SimParams,
    ) -> GpuMultilevel {
        assert!(!levels.is_empty(), "multilevel layout needs a level");
        let programs = Programs::new(&device);
        let coarsest = levels.len() - 1;
        let positions = seed_disc_positions(levels[coarsest].graph.node_count() as usize, seed);
        let mut out = GpuMultilevel {
            device,
            queue,
            programs,
            levels,
            seed,
            params,
            li: coarsest,
            sim: None,
            positions,
            iters: 0,
            iter: 0,
            done: false,
        };
        out.begin_level();
        out
    }

    fn begin_level(&mut self) {
        let count = self.levels.len();
        let level = &self.levels[self.li];
        let n = level.graph.node_count() as usize;
        let shift = (count - 1 - self.li) as u32;
        // Coarsest gets the long sim; budgets halve as levels grow finer.
        // No `max_sim_nodes` cap: unlike D11's WASM tier every level is
        // simulated (D15 — that is the point of the native build).
        let iters = COARSEST_ITERS
            .checked_shr(shift)
            .unwrap_or(0)
            .max(MIN_ITERS);
        self.iters = iters;
        self.iter = 0;

        self.sim = Some(LevelSim::new(
            &self.device,
            &self.programs,
            &level.graph.offsets,
            level.graph.targets(),
            level.graph.weights(),
            &self.positions,
            self.params,
            LevelSchedule::for_level(n, self.li == count - 1),
            iters,
        ));
    }

    /// Advance at most `budget` iterations, crossing level boundaries as
    /// needed. Returns true once the finest level is finished.
    pub fn step(&mut self, budget: u32) -> bool {
        if self.done {
            return true;
        }
        let mut used = 0;
        while used < budget.max(1) {
            if self.iter < self.iters {
                let sim = self.sim.as_mut().expect("sim exists while iters remain");
                sim.step(&self.device, &self.queue, &self.programs);
                self.iter += 1;
                used += 1;
                continue;
            }

            // Level finished: pull positions back, then prolongate or stop.
            let sim = self.sim.take().expect("sim exists at level end");
            self.positions = sim.read(&self.device, &self.queue);
            drop(sim);

            if self.li == 0 {
                self.done = true;
                return true;
            }
            let coarse_n = self.levels[self.li].graph.node_count() as usize;
            let finer = self.li - 1;
            self.positions = prolongate_positions(
                &self.positions,
                &self.levels[finer].parent_map,
                coarse_n,
                self.seed,
                finer,
            );
            self.li = finer;
            self.begin_level();
        }
        false
    }

    /// Current positions, pulled from the GPU. Blocks; use on preview ticks.
    pub fn read_positions(&self) -> Vec<f32> {
        match &self.sim {
            Some(sim) => sim.read(&self.device, &self.queue),
            None => self.positions.clone(),
        }
    }

    pub fn progress(&self) -> LayoutProgress {
        let count = self.levels.len();
        LayoutProgress {
            level: (count - self.li) as u32,
            levels: count as u32,
            iter: self.iter,
            iters: self.iters,
            nodes: self.levels[self.li].graph.node_count(),
        }
    }

    /// True while the finest level is being refined — the only level whose
    /// node count matches the renderer's buffers.
    pub fn at_finest(&self) -> bool {
        self.li == 0
    }
}
