//! Deterministic force layout (REQUIREMENTS.md §6): the CPU force engine and
//! the multilevel driver that runs it coarsest-level-first.
//!
//! This is the reference implementation of the algorithm — the WGSL compute
//! shader in `web/src/layout/gpu.ts` is the same maths on the GPU and must be
//! kept in step with it. The scheme:
//!
//!   repulsion: two uniform grids over the fixed world square (GRID² fine
//!     cells, GRID2² coarse cells). Per iteration each cell aggregates
//!     {count, Σposition}. Each node then repels from the 5×5 fine block
//!     around it (point mass per cell, self removed), the 5×5 coarse block as
//!     25 distinct mid-range bodies (with the fine block's aggregate
//!     subtracted exactly from the coarse cells containing it), and one
//!     residual far body (root − coarse block). Mid-range bodies are what
//!     separates clusters — a single global far body has no direction.
//!   attraction: linear ForceAtlas2-style springs along the symmetrized CSR,
//!     walked in neighbour order, each divided by √((deg_i+1)(deg_j+1)).
//!   integration: Fruchterman–Reingold displacement clamp with exponential
//!     cooling; positions clamped to the world square.
//!
//! Determinism (DECISIONS.md D2): every accumulation happens in a fixed order
//! — nodes in index order, neighbours in CSR order, cells in grid order — so
//! the same input and seed give the same picture, bit for bit. All RNG goes
//! through [`Mulberry32`], the project-wide seeded generator.

use crate::HierarchyLevel;

/// The layout lives in a fixed square; the renderer's camera fits to it.
pub const WORLD_SIZE: f32 = 4096.0;
/// Fine repulsion grid resolution (cells per side).
pub const GRID: usize = 128;
/// Coarse repulsion grid resolution (cells per side).
pub const GRID2: usize = 16;

const WORLD: f64 = WORLD_SIZE as f64;
const CELL: f64 = WORLD / GRID as f64;
const CELL2: f64 = WORLD / GRID2 as f64;
/// Fine cells per coarse cell, per side.
const FPC: usize = GRID / GRID2;

/// Iterations at the coarsest level; budgets halve per finer level.
pub const COARSEST_ITERS: u32 = 300;
/// Floor for the per-level iteration budget.
pub const MIN_ITERS: u32 = 40;

/// mulberry32 — the project-wide seeded generator, bit-compatible with the
/// JavaScript implementation the render path uses (`web/src/layout/params.ts`).
pub struct Mulberry32(u32);

impl Mulberry32 {
    pub fn new(seed: u32) -> Mulberry32 {
        Mulberry32(seed)
    }

    /// Next draw in `[0, 1)`.
    pub fn next_f64(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let a = self.0;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        f64::from(t ^ (t >> 14)) / 4294967296.0
    }
}

/// Fruchterman–Reingold-scaled parameters, dimensionless where possible:
/// attraction per edge is `w·d/k`-ish (see the module docs), repulsion per
/// body is `c·k²/d²`, with `k = k_opt = world/√n` computed per level.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SimParams {
    pub attraction_scale: f64,
    pub repulsion_scale: f64,
    /// Pull toward the world centre, as a fraction of distance per step unit.
    pub gravity: f64,
    /// Aggregated multi-edge weights are capped so hubs don't implode.
    pub weight_cap: f64,
}

impl Default for SimParams {
    fn default() -> SimParams {
        SimParams {
            attraction_scale: 1.0,
            repulsion_scale: 1.0,
            gravity: 0.03,
            weight_cap: 8.0,
        }
    }
}

/// Per-level derived quantities: natural spacing and the cooling schedule.
#[derive(Clone, Copy, Debug)]
pub struct LevelSchedule {
    pub k_opt: f64,
    pub step_start: f64,
    pub step_end: f64,
}

impl LevelSchedule {
    pub fn for_level(n: usize, is_coarsest: bool) -> LevelSchedule {
        let k_opt = WORLD / (n.max(1) as f64).sqrt();
        LevelSchedule {
            k_opt,
            // The coarsest level starts from random scatter and needs big
            // moves; refinement levels start near-converged from prolongation.
            step_start: if is_coarsest {
                WORLD / 8.0
            } else {
                4.0 * k_opt
            },
            step_end: (0.3 * k_opt).max(0.3),
        }
    }

    /// Exponential cooling schedule.
    pub fn step_at(&self, iter: u32, iters: u32) -> f64 {
        if iters <= 1 {
            return self.step_end;
        }
        let t = f64::from(iter) / f64::from(iters - 1);
        self.step_start * (self.step_end / self.step_start).powf(t)
    }
}

/// One level's adjacency: a symmetrized, weighted CSR borrowed from the
/// hierarchy. Flat slices only (§4.2).
#[derive(Clone, Copy)]
pub struct LevelGraph<'a> {
    pub offsets: &'a [u32],
    pub targets: &'a [u32],
    /// Parallel to `targets`; empty means every edge weighs 1.
    pub weights: &'a [f32],
}

impl<'a> LevelGraph<'a> {
    pub fn new(offsets: &'a [u32], targets: &'a [u32], weights: &'a [f32]) -> LevelGraph<'a> {
        LevelGraph {
            offsets,
            targets,
            weights,
        }
    }

    pub fn node_count(&self) -> usize {
        self.offsets.len().saturating_sub(1)
    }

    fn weight(&self, e: usize) -> f64 {
        if self.weights.is_empty() {
            1.0
        } else {
            f64::from(self.weights[e])
        }
    }
}

/// Seeded uniform scatter over a disc centred in the world — the coarsest
/// level's starting configuration.
pub fn seed_disc_positions(n: usize, seed: u32) -> Vec<f32> {
    let mut rand = Mulberry32::new(seed);
    let mut xy = vec![0f32; 2 * n];
    let c = WORLD / 2.0;
    let r = WORLD / 4.0;
    for i in 0..n {
        let a = rand.next_f64() * 2.0 * std::f64::consts::PI;
        let d = rand.next_f64().sqrt() * r;
        xy[2 * i] = (c + a.cos() * d) as f32;
        xy[2 * i + 1] = (c + a.sin() * d) as f32;
    }
    xy
}

/// Push a coarse level's positions down to the finer level: each node starts
/// at its parent's position plus seeded jitter scaled to the coarse spacing.
/// `parent_map` is the finer level's map into the coarse level.
pub fn prolongate_positions(
    coarse: &[f32],
    parent_map: &[u32],
    coarse_n: usize,
    seed: u32,
    level_index: usize,
) -> Vec<f32> {
    let mixed = (level_index as u64).wrapping_mul(0x9e37_79b9) as u32;
    let mut rand = Mulberry32::new(seed ^ mixed);
    let jitter = 0.5 * WORLD / (coarse_n.max(1) as f64).sqrt();
    let n = parent_map.len();
    let mut xy = vec![0f32; 2 * n];
    for i in 0..n {
        let p = parent_map[i] as usize;
        xy[2 * i] = (f64::from(coarse[2 * p]) + (rand.next_f64() - 0.5) * jitter) as f32;
        xy[2 * i + 1] = (f64::from(coarse[2 * p + 1]) + (rand.next_f64() - 0.5) * jitter) as f32;
    }
    xy
}

/// The CPU force engine for one hierarchy level: cooling state plus the grid
/// scratch buffers, so a caller can drive it an iteration at a time (the
/// worker posts progress between chunks).
pub struct LevelSim {
    params: SimParams,
    schedule: LevelSchedule,
    iters: u32,
    iter: u32,
    next: Vec<f32>,
    fine_count: Vec<u32>,
    fine_sum_x: Vec<f64>,
    fine_sum_y: Vec<f64>,
    coarse_count: Vec<u32>,
    coarse_sum_x: Vec<f64>,
    coarse_sum_y: Vec<f64>,
}

impl LevelSim {
    pub fn new(params: SimParams, schedule: LevelSchedule, iters: u32) -> LevelSim {
        LevelSim {
            params,
            schedule,
            iters,
            iter: 0,
            next: Vec::new(),
            fine_count: vec![0; GRID * GRID],
            fine_sum_x: vec![0.0; GRID * GRID],
            fine_sum_y: vec![0.0; GRID * GRID],
            coarse_count: vec![0; GRID2 * GRID2],
            coarse_sum_x: vec![0.0; GRID2 * GRID2],
            coarse_sum_y: vec![0.0; GRID2 * GRID2],
        }
    }

    /// Run a whole level to completion — the shape tests and calibration want.
    pub fn run(
        level: &LevelGraph<'_>,
        positions: &mut [f32],
        params: SimParams,
        schedule: LevelSchedule,
        iters: u32,
    ) {
        let mut sim = LevelSim::new(params, schedule, iters);
        for _ in 0..iters {
            sim.step(level, positions);
        }
    }

    /// One iteration; rewrites `positions` in place at the end.
    pub fn step(&mut self, level: &LevelGraph<'_>, positions: &mut [f32]) {
        let n = level.node_count();
        debug_assert_eq!(positions.len(), 2 * n);
        if self.next.len() != positions.len() {
            self.next = vec![0f32; positions.len()];
        }

        let step_size = self.schedule.step_at(self.iter, self.iters);
        self.iter += 1;
        let k_opt = self.schedule.k_opt;
        // Degree-dissuaded attraction (ForceAtlas2's hub fix): normalise each
        // edge by the endpoint degrees, rescaled by the mean degree so
        // near-regular graphs keep the plain FR balance.
        let avg_deg = level.targets.len() as f64 / n.max(1) as f64;
        // Linear attraction balances repulsion k²/d² at spacing d≈k_opt when
        // the per-typical-edge coefficient is ≈k_opt; dis ≈ avg_deg for
        // typical edges.
        let a_scale = self.params.attraction_scale * avg_deg * k_opt;
        let r_scale = self.params.repulsion_scale * k_opt * k_opt;

        self.fine_count.fill(0);
        self.fine_sum_x.fill(0.0);
        self.fine_sum_y.fill(0.0);
        self.coarse_count.fill(0);
        self.coarse_sum_x.fill(0.0);
        self.coarse_sum_y.fill(0.0);
        let mut root_count = 0f64;
        let mut root_sum_x = 0f64;
        let mut root_sum_y = 0f64;
        for i in 0..n {
            let x = f64::from(positions[2 * i]);
            let y = f64::from(positions[2 * i + 1]);
            let f = fine_cell(x, y);
            self.fine_count[f] += 1;
            self.fine_sum_x[f] += x;
            self.fine_sum_y[f] += y;
            let c = coarse_cell(x, y);
            self.coarse_count[c] += 1;
            self.coarse_sum_x[c] += x;
            self.coarse_sum_y[c] += y;
            root_count += 1.0;
            root_sum_x += x;
            root_sum_y += y;
        }

        for i in 0..n {
            let px = f64::from(positions[2 * i]);
            let py = f64::from(positions[2 * i + 1]);
            let mut fx = 0f64;
            let mut fy = 0f64;

            // Springs, in CSR neighbor order: linear (ForceAtlas2-style)
            // attraction, divided by √((deg_i+1)(deg_j+1)) so hubs don't
            // collapse the graph. Linear beats FR's d²/k here: stronger
            // inside clusters, far weaker across the graph's diameter.
            let start = level.offsets[i] as usize;
            let end = level.offsets[i + 1] as usize;
            let deg_i = (end - start) as f64;
            for e in start..end {
                let j = level.targets[e] as usize;
                let w = level.weight(e).min(self.params.weight_cap);
                let deg_j = (level.offsets[j + 1] as usize - level.offsets[j] as usize) as f64;
                let dis = ((deg_i + 1.0) * (deg_j + 1.0)).sqrt();
                fx += (f64::from(positions[2 * j]) - px) * a_scale * w / dis;
                fy += (f64::from(positions[2 * j + 1]) - py) * a_scale * w / dis;
            }

            // Subtraction entries: fine-block portions inside each coarse cell
            // (a 5-fine-cell block overlaps at most 2×2 coarse cells).
            let mut sub_idx = [-1i64; 4];
            let mut sub_k = [0f64; 4];
            let mut sub_x = [0f64; 4];
            let mut sub_y = [0f64; 4];

            // Near field: 5×5 fine cells, self removed from its own cell.
            let fcx = axis_cell(px, CELL, GRID);
            let fcy = axis_cell(py, CELL, GRID);
            for dy in -2i64..=2 {
                let gy = fcy as i64 + dy;
                if gy < 0 || gy >= GRID as i64 {
                    continue;
                }
                for dx in -2i64..=2 {
                    let gx = fcx as i64 + dx;
                    if gx < 0 || gx >= GRID as i64 {
                        continue;
                    }
                    let c = gy as usize * GRID + gx as usize;
                    if self.fine_count[c] == 0 {
                        continue;
                    }
                    let mut k = f64::from(self.fine_count[c]);
                    let mut sx = self.fine_sum_x[c];
                    let mut sy = self.fine_sum_y[c];
                    if dx == 0 && dy == 0 {
                        k -= 1.0;
                        sx -= px;
                        sy -= py;
                    }
                    // Record this fine cell against its containing coarse cell.
                    let ci = (gy / FPC as i64) * GRID2 as i64 + gx / FPC as i64;
                    for s in 0..4 {
                        if sub_idx[s] == ci || sub_idx[s] == -1 {
                            sub_idx[s] = ci;
                            sub_k[s] += k;
                            sub_x[s] += sx;
                            sub_y[s] += sy;
                            break;
                        }
                    }
                    if k == 0.0 {
                        continue;
                    }
                    let dxx = px - sx / k;
                    let dyy = py - sy / k;
                    let d2 = dxx * dxx + dyy * dyy + 0.01;
                    let s = r_scale * k / d2;
                    fx += dxx * s;
                    fy += dyy * s;
                }
            }

            // Mid field: 5×5 coarse cells as distinct bodies, fine block (and
            // self) subtracted exactly from the cells that contain them.
            let ccx = axis_cell(px, CELL2, GRID2);
            let ccy = axis_cell(py, CELL2, GRID2);
            let self_coarse = (ccy * GRID2 + ccx) as i64;
            let mut block_count = 0f64;
            let mut block_sum_x = 0f64;
            let mut block_sum_y = 0f64;
            for dy in -2i64..=2 {
                let gy = ccy as i64 + dy;
                if gy < 0 || gy >= GRID2 as i64 {
                    continue;
                }
                for dx in -2i64..=2 {
                    let gx = ccx as i64 + dx;
                    if gx < 0 || gx >= GRID2 as i64 {
                        continue;
                    }
                    let ci = gy * GRID2 as i64 + gx;
                    let c = ci as usize;
                    let raw_k = f64::from(self.coarse_count[c]);
                    block_count += raw_k;
                    block_sum_x += self.coarse_sum_x[c];
                    block_sum_y += self.coarse_sum_y[c];
                    if raw_k == 0.0 {
                        continue;
                    }
                    let mut k = raw_k;
                    let mut sx = self.coarse_sum_x[c];
                    let mut sy = self.coarse_sum_y[c];
                    for s in 0..4 {
                        if sub_idx[s] == ci {
                            k -= sub_k[s];
                            sx -= sub_x[s];
                            sy -= sub_y[s];
                        }
                    }
                    if ci == self_coarse {
                        k -= 1.0;
                        sx -= px;
                        sy -= py;
                    }
                    if k <= 0.0 {
                        continue;
                    }
                    let dxx = px - sx / k;
                    let dyy = py - sy / k;
                    let d2 = dxx * dxx + dyy * dyy + 0.01;
                    let s = r_scale * k / d2;
                    fx += dxx * s;
                    fy += dyy * s;
                }
            }

            // Far field: everything beyond the coarse block, one residual body.
            let far_count = root_count - block_count;
            if far_count > 0.0 {
                let far_x = root_sum_x - block_sum_x;
                let far_y = root_sum_y - block_sum_y;
                let dxx = px - far_x / far_count;
                let dyy = py - far_y / far_count;
                let d2 = dxx * dxx + dyy * dyy + 0.01;
                let s = r_scale * far_count / d2;
                fx += dxx * s;
                fy += dyy * s;
            }

            // Gravity toward the world centre.
            fx += (WORLD / 2.0 - px) * self.params.gravity;
            fy += (WORLD / 2.0 - py) * self.params.gravity;

            // FR displacement clamp.
            let len = fx.hypot(fy);
            let mut nx = px;
            let mut ny = py;
            if len > 1e-9 {
                let d = len.min(step_size) / len;
                nx += fx * d;
                ny += fy * d;
            }
            self.next[2 * i] = nx.clamp(0.0, WORLD) as f32;
            self.next[2 * i + 1] = ny.clamp(0.0, WORLD) as f32;
        }

        positions.copy_from_slice(&self.next);
    }
}

fn axis_cell(v: f64, cell: f64, grid: usize) -> usize {
    ((v / cell).floor() as i64).clamp(0, grid as i64 - 1) as usize
}

fn fine_cell(x: f64, y: f64) -> usize {
    axis_cell(y, CELL, GRID) * GRID + axis_cell(x, CELL, GRID)
}

fn coarse_cell(x: f64, y: f64) -> usize {
    axis_cell(y, CELL2, GRID2) * GRID2 + axis_cell(x, CELL2, GRID2)
}

/// Where the multilevel driver currently is, for progress reporting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LayoutProgress {
    /// 1-based, counting from the coarsest level.
    pub level: u32,
    pub levels: u32,
    pub iter: u32,
    pub iters: u32,
    pub nodes: u32,
}

/// Multilevel layout (§6): lay out the coarsest level with a long sim,
/// prolongate down (parent position + seeded jitter), refine each finer level
/// with a shrinking iteration budget. Levels beyond `max_sim_nodes` get
/// prolongation only — §8 graceful degradation, still deterministic.
///
/// Driven in chunks via [`MultilevelLayout::step`] so the caller can report
/// progress and stay responsive between iterations.
pub struct MultilevelLayout {
    /// Finest first; `levels[0]` is the symmetrized input graph.
    levels: Vec<HierarchyLevel>,
    seed: u32,
    params: SimParams,
    max_sim_nodes: usize,
    /// Index of the level being worked on; counts down to 0.
    li: usize,
    iters: u32,
    iter: u32,
    sim: Option<LevelSim>,
    positions: Vec<f32>,
    done: bool,
}

impl MultilevelLayout {
    /// `levels` comes from [`crate::build_hierarchy`] — finest first.
    pub fn new(
        levels: Vec<HierarchyLevel>,
        seed: u32,
        params: SimParams,
        max_sim_nodes: usize,
    ) -> MultilevelLayout {
        assert!(
            !levels.is_empty(),
            "multilevel layout needs at least one level"
        );
        let coarsest = levels.len() - 1;
        let positions = seed_disc_positions(levels[coarsest].graph.node_count() as usize, seed);
        let mut layout = MultilevelLayout {
            levels,
            seed,
            params,
            max_sim_nodes,
            li: coarsest,
            iters: 0,
            iter: 0,
            sim: None,
            positions,
            done: false,
        };
        layout.begin_level();
        layout
    }

    /// Run the whole layout in one call (native tests, benches, calibration).
    pub fn run(
        levels: Vec<HierarchyLevel>,
        seed: u32,
        params: SimParams,
        max_sim_nodes: usize,
    ) -> Vec<f32> {
        let mut layout = MultilevelLayout::new(levels, seed, params, max_sim_nodes);
        while !layout.step(64) {}
        layout.into_positions()
    }

    fn begin_level(&mut self) {
        let count = self.levels.len();
        let n = self.levels[self.li].graph.node_count() as usize;
        let shift = (count - 1 - self.li) as u32;
        // Coarsest gets the long sim; budgets halve as levels grow finer.
        let mut iters = COARSEST_ITERS
            .checked_shr(shift)
            .unwrap_or(0)
            .max(MIN_ITERS);
        if n > self.max_sim_nodes {
            iters = 0; // prolongation only — this tier can't afford the level
        }
        self.iters = iters;
        self.iter = 0;
        self.sim = (iters > 0).then(|| {
            LevelSim::new(
                self.params,
                LevelSchedule::for_level(n, self.li == count - 1),
                iters,
            )
        });
    }

    /// Advance at most `budget` force iterations, crossing level boundaries as
    /// needed. Returns true once the finest level is finished.
    pub fn step(&mut self, budget: u32) -> bool {
        if self.done {
            return true;
        }
        let mut used = 0;
        while used < budget.max(1) {
            if self.iter < self.iters {
                let level = &self.levels[self.li].graph;
                let graph = LevelGraph::new(&level.offsets, level.targets(), level.weights());
                // Disjoint field borrows: graph reads `levels`, the sim and
                // positions are separate fields.
                let sim = self.sim.as_mut().expect("sim exists while iters remain");
                sim.step(&graph, &mut self.positions);
                self.iter += 1;
                used += 1;
                continue;
            }
            if self.li == 0 {
                self.sim = None;
                self.done = true;
                return true;
            }
            let coarse_n = self.levels[self.li].graph.node_count() as usize;
            let parent_map = &self.levels[self.li - 1].parent_map;
            self.positions =
                prolongate_positions(&self.positions, parent_map, coarse_n, self.seed, self.li);
            self.li -= 1;
            self.begin_level();
        }
        false
    }

    pub fn is_done(&self) -> bool {
        self.done
    }

    pub fn progress(&self) -> LayoutProgress {
        let count = self.levels.len() as u32;
        LayoutProgress {
            level: count - self.li as u32,
            levels: count,
            iter: self.iter,
            iters: self.iters,
            nodes: self.levels[self.li].graph.node_count(),
        }
    }

    /// Positions at the level currently being refined — a live view, useful as
    /// a preview once the driver reaches the finest level.
    pub fn positions(&self) -> &[f32] {
        &self.positions
    }

    pub fn into_positions(self) -> Vec<f32> {
        self.positions
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{build_hierarchy, Csr};

    /// Two cliques of `size`, joined by a single edge, as a symmetrized level.
    fn two_cliques(size: usize) -> (Vec<u32>, Vec<u32>, Vec<f32>) {
        let n = 2 * size;
        let mut offsets = vec![0u32; n + 1];
        let mut targets = Vec::new();
        for i in 0..n {
            let base = if i < size { 0 } else { size };
            for j in base..base + size {
                if j != i {
                    targets.push(j as u32);
                }
            }
            if i == 0 {
                targets.push(size as u32);
            }
            if i == size {
                targets.push(0);
            }
            offsets[i + 1] = targets.len() as u32;
        }
        let weights = vec![1.0f32; targets.len()];
        (offsets, targets, weights)
    }

    fn run_two_cliques(size: usize, seed: u32, iters: u32) -> Vec<f32> {
        let (offsets, targets, weights) = two_cliques(size);
        let graph = LevelGraph::new(&offsets, &targets, &weights);
        let mut positions = seed_disc_positions(graph.node_count(), seed);
        LevelSim::run(
            &graph,
            &mut positions,
            SimParams::default(),
            LevelSchedule::for_level(graph.node_count(), true),
            iters,
        );
        positions
    }

    #[test]
    fn mulberry32_matches_typescript() {
        // Values logged from `mulberry32(42)` in web/src/layout/params.ts —
        // the port must not drift from the generator the render path uses.
        let mut rand = Mulberry32::new(42);
        let draws = [
            rand.next_f64(),
            rand.next_f64(),
            rand.next_f64(),
            rand.next_f64(),
        ];
        assert_eq!(
            draws,
            [
                0.6011037519201636,
                0.44829055899754167,
                0.8524657934904099,
                0.6697340414393693,
            ]
        );
        assert_eq!(Mulberry32::new(0).next_f64(), 0.26642920868471265);
    }

    #[test]
    fn deterministic_bit_for_bit() {
        let a = run_two_cliques(20, 42, 40);
        let b = run_two_cliques(20, 42, 40);
        assert_eq!(a, b);
        let c = run_two_cliques(20, 7, 40);
        assert_ne!(a, c);
    }

    #[test]
    fn stays_in_world() {
        for v in run_two_cliques(30, 42, 60) {
            assert!((0.0..=WORLD_SIZE).contains(&v), "position escaped: {v}");
        }
    }

    #[test]
    fn cliques_separate() {
        // The Rust-side stand-in for M3's "clustered fixture must separate"
        // visual gate (DECISIONS.md D9): two dense groups joined by one edge
        // must end up further apart than they are wide.
        let size = 50;
        let pos = run_two_cliques(size, 42, 300);
        let centroid = |range: std::ops::Range<usize>| {
            let (mut cx, mut cy) = (0f64, 0f64);
            for i in range.clone() {
                cx += f64::from(pos[2 * i]);
                cy += f64::from(pos[2 * i + 1]);
            }
            let k = range.len() as f64;
            (cx / k, cy / k)
        };
        let (ax, ay) = centroid(0..size);
        let (bx, by) = centroid(size..2 * size);
        let spread = |range: std::ops::Range<usize>, c: (f64, f64)| {
            let mut s = 0f64;
            for i in range.clone() {
                s += (f64::from(pos[2 * i]) - c.0).hypot(f64::from(pos[2 * i + 1]) - c.1);
            }
            s / range.len() as f64
        };
        let intra = spread(0..size, (ax, ay)).max(spread(size..2 * size, (bx, by)));
        let inter = (ax - bx).hypot(ay - by);
        assert!(
            inter > 2.0 * intra,
            "cliques did not separate: inter {inter:.1} vs intra {intra:.1}"
        );
    }

    #[test]
    fn prolongation_is_seeded_and_near_parent() {
        let coarse = vec![100.0f32, 200.0, 300.0, 400.0];
        let parent_map = vec![0u32, 0, 1, 1, 1];
        let a = prolongate_positions(&coarse, &parent_map, 2, 42, 1);
        let b = prolongate_positions(&coarse, &parent_map, 2, 42, 1);
        assert_eq!(a, b);
        // A different level index re-keys the generator.
        assert_ne!(a, prolongate_positions(&coarse, &parent_map, 2, 42, 2));
        // Jitter is bounded by half the coarse spacing.
        let jitter = 0.5 * WORLD / 2f64.sqrt();
        for i in 0..parent_map.len() {
            let p = parent_map[i] as usize;
            let bound = jitter / 2.0 + 1e-3;
            assert!((f64::from(a[2 * i]) - f64::from(coarse[2 * p])).abs() <= bound);
            assert!((f64::from(a[2 * i + 1]) - f64::from(coarse[2 * p + 1])).abs() <= bound);
        }
    }

    /// A planted-partition graph: `groups` dense communities, sparsely linked.
    fn planted(groups: usize, per_group: usize, seed: u32) -> Csr {
        let n = groups * per_group;
        let mut rand = Mulberry32::new(seed);
        let mut sources = Vec::new();
        let mut targets = Vec::new();
        for g in 0..groups {
            for i in 0..per_group {
                let u = g * per_group + i;
                for _ in 0..6 {
                    let v = g * per_group + (rand.next_f64() * per_group as f64) as usize;
                    if v != u {
                        sources.push(u as u32);
                        targets.push(v as u32);
                    }
                }
                if rand.next_f64() < 0.02 {
                    let v = (rand.next_f64() * n as f64) as usize;
                    sources.push(u as u32);
                    targets.push(v as u32);
                }
            }
        }
        Csr::from_edges(n as u32, &sources, &targets, None)
    }

    #[test]
    fn multilevel_is_deterministic_and_separates_communities() {
        let groups = 8;
        let per_group = 200;
        let csr = planted(groups, per_group, 1);
        let levels = build_hierarchy(&csr, 50, 8);
        assert!(levels.len() > 1, "expected a real hierarchy");
        let a = MultilevelLayout::run(
            build_hierarchy(&csr, 50, 8),
            42,
            SimParams::default(),
            usize::MAX,
        );
        let b = MultilevelLayout::run(levels, 42, SimParams::default(), usize::MAX);
        assert_eq!(a, b);
        assert_eq!(a.len(), 2 * groups * per_group);

        // Communities are contiguous index ranges by construction.
        let centroid = |g: usize| {
            let (mut cx, mut cy) = (0f64, 0f64);
            for i in g * per_group..(g + 1) * per_group {
                cx += f64::from(a[2 * i]);
                cy += f64::from(a[2 * i + 1]);
            }
            (cx / per_group as f64, cy / per_group as f64)
        };
        let mut intra = 0f64;
        for g in 0..groups {
            let c = centroid(g);
            for i in g * per_group..(g + 1) * per_group {
                intra += (f64::from(a[2 * i]) - c.0).hypot(f64::from(a[2 * i + 1]) - c.1);
            }
        }
        intra /= (groups * per_group) as f64;
        let mut inter = 0f64;
        let mut pairs = 0f64;
        for g in 0..groups {
            for h in g + 1..groups {
                let (p, q) = (centroid(g), centroid(h));
                inter += (p.0 - q.0).hypot(p.1 - q.1);
                pairs += 1.0;
            }
        }
        inter /= pairs;
        assert!(
            inter > 3.0 * intra,
            "communities did not separate: inter {inter:.0} vs intra {intra:.0}"
        );
    }

    #[test]
    fn node_cap_falls_back_to_prolongation_only() {
        let csr = planted(4, 100, 3);
        let levels = build_hierarchy(&csr, 50, 8);
        let count = levels.len();
        // Cap below every level size: only the coarsest may sim... and it too
        // is skipped, so the result is seeded scatter pushed down the levels.
        let mut layout = MultilevelLayout::new(levels, 42, SimParams::default(), 1);
        let mut chunks = 0;
        while !layout.step(64) {
            chunks += 1;
            assert!(chunks < 1000, "prolongation-only layout failed to finish");
        }
        let p = layout.progress();
        assert_eq!(p.level, count as u32);
        assert_eq!(p.iters, 0);
        assert_eq!(layout.into_positions().len(), 2 * 400);
    }
}
