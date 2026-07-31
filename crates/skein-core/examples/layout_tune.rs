//! Layout calibration harness — the fast loop for force-parameter work
//! (DECISIONS.md D9/D10). Generates the `clustered` fixture's planted-partition
//! graph natively (same xorshift64* generator as `bench/generate-fixtures.mjs`,
//! so the graph is identical), runs the CPU sim at several parameter combos and
//! prints separation metrics: a correct layout keeps the planted communities
//! apart, and the ratio is what regressions show up in.
//!
//! Also times single-level sims at a few node counts, which is what sets the
//! no-WebGPU node cap — but those numbers are *native*; the shipping cap must
//! come from the same sim running as WASM in a browser (`tests/manual-layout-
//! fallback.mjs`).
//!
//! Run: cargo run --release --example layout_tune [attraction] [repulsion]

use skein_core::{
    seed_disc_positions, symmetrize, Csr, LevelGraph, LevelSchedule, LevelSim, SimParams,
};
use std::time::Instant;

const WORLD: f64 = 4096.0;
const NODES: usize = 20_000;
const EDGES: usize = 120_000;
const COMMUNITIES: usize = 40;
const P_INTRA: f64 = 0.92;
const ITERS: u32 = 300;

/// xorshift64*, matching bench/generate-fixtures.mjs bit for bit.
struct Rng(u64);
impl Rng {
    fn next_f64(&mut self) -> f64 {
        let mut s = self.0;
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        self.0 = s;
        ((s.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 32) as f64) / 4294967296.0
    }
}

/// Planted partition: nodes split into equal communities; each edge is
/// intra-community with probability `p_intra`, else uniform across the graph.
fn clustered(nodes: usize, edges: usize, communities: usize, p_intra: f64) -> Csr {
    let mut rng = Rng(0x5eed);
    let size = nodes / communities;
    let mut src = Vec::with_capacity(edges);
    let mut dst = Vec::with_capacity(edges);
    for _ in 0..edges {
        let c = (rng.next_f64() * communities as f64) as usize;
        let base = c * size;
        let a = base + (rng.next_f64() * size as f64) as usize;
        let b = if rng.next_f64() < p_intra {
            base + (rng.next_f64() * size as f64) as usize
        } else {
            (rng.next_f64() * nodes as f64) as usize
        };
        src.push(a as u32);
        dst.push(if a == b {
            (base + (a - base + 1) % size) as u32
        } else {
            b as u32
        });
    }
    symmetrize(&Csr::from_edges(nodes as u32, &src, &dst, None))
}

/// A regular-ish graph of `n` nodes with ~6 edges each — for timing only.
fn uniform(n: usize, per_node: usize) -> Csr {
    let mut rng = Rng(0xc0ffee);
    let mut src = Vec::with_capacity(n * per_node);
    let mut dst = Vec::with_capacity(n * per_node);
    for u in 0..n {
        for _ in 0..per_node {
            src.push(u as u32);
            dst.push((rng.next_f64() * n as f64) as u32 % n as u32);
        }
    }
    symmetrize(&Csr::from_edges(n as u32, &src, &dst, None))
}

fn as_level(csr: &Csr) -> LevelGraph<'_> {
    LevelGraph::new(
        &csr.offsets,
        &csr.targets,
        csr.weights.as_deref().unwrap_or(&[]),
    )
}

struct Metrics {
    intra: f64,
    inter: f64,
    separation: f64,
    span: (f64, f64),
    walls: bool,
}

fn metrics(pos: &[f32], nodes: usize) -> Metrics {
    let size = nodes / COMMUNITIES;
    let community = |i: usize| (i / size).min(COMMUNITIES - 1);
    let mut cx = vec![0f64; COMMUNITIES];
    let mut cy = vec![0f64; COMMUNITIES];
    for i in 0..nodes {
        cx[community(i)] += f64::from(pos[2 * i]);
        cy[community(i)] += f64::from(pos[2 * i + 1]);
    }
    for c in 0..COMMUNITIES {
        cx[c] /= size as f64;
        cy[c] /= size as f64;
    }
    let (mut intra, mut min_x, mut max_x, mut min_y, mut max_y) =
        (0f64, f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for i in 0..nodes {
        let (x, y) = (f64::from(pos[2 * i]), f64::from(pos[2 * i + 1]));
        let c = community(i);
        intra += (x - cx[c]).hypot(y - cy[c]);
        min_x = min_x.min(x);
        max_x = max_x.max(x);
        min_y = min_y.min(y);
        max_y = max_y.max(y);
    }
    intra /= nodes as f64;
    let (mut inter, mut pairs) = (0f64, 0f64);
    for a in 0..COMMUNITIES {
        for b in a + 1..COMMUNITIES {
            inter += (cx[a] - cx[b]).hypot(cy[a] - cy[b]);
            pairs += 1.0;
        }
    }
    inter /= pairs;
    Metrics {
        intra,
        inter,
        separation: inter / intra.max(1.0),
        span: (max_x - min_x, max_y - min_y),
        walls: min_x < 1.0 || min_y < 1.0 || max_x > WORLD - 1.0 || max_y > WORLD - 1.0,
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let variants: Vec<(f64, f64)> = if args.len() >= 2 {
        vec![(args[0].parse().unwrap(), args[1].parse().unwrap())]
    } else {
        vec![(1.0, 1.0), (2.0, 1.0), (1.0, 2.0), (0.5, 1.0)]
    };

    let csr = clustered(NODES, EDGES, COMMUNITIES, P_INTRA);
    let level = as_level(&csr);
    println!(
        "clustered: {NODES} nodes, {EDGES} edges, {COMMUNITIES} communities \
         ({} symmetrized arcs)",
        csr.targets.len()
    );
    for (a, r) in variants {
        let params = SimParams {
            attraction_scale: a,
            repulsion_scale: r,
            ..SimParams::default()
        };
        let mut positions = seed_disc_positions(NODES, 42);
        let t0 = Instant::now();
        LevelSim::run(
            &level,
            &mut positions,
            params,
            LevelSchedule::for_level(NODES, true),
            ITERS,
        );
        let secs = t0.elapsed().as_secs_f64();
        let m = metrics(&positions, NODES);
        println!(
            "a={a} r={r} → intra {:.0}  inter {:.0}  separation {:.2}  span {:.0}×{:.0}{}  \
             ({secs:.1}s / {ITERS} iters)",
            m.intra,
            m.inter,
            m.separation,
            m.span.0,
            m.span.1,
            if m.walls { "  WALLS" } else { "" },
        );
    }

    // Single-level cost vs node count — informs the no-WebGPU cap (D10).
    println!("\nsingle-level timings (native; WASM in-browser is the number that ships):");
    for n in [100_000usize, 250_000, 500_000] {
        let csr = uniform(n, 6);
        let level = as_level(&csr);
        let mut positions = seed_disc_positions(n, 42);
        let mut sim = LevelSim::new(SimParams::default(), LevelSchedule::for_level(n, false), 40);
        let t0 = Instant::now();
        let probe = 5;
        for _ in 0..probe {
            sim.step(&level, &mut positions);
        }
        let ms = t0.elapsed().as_secs_f64() * 1000.0 / f64::from(probe);
        println!(
            "n={n}: {ms:.1} ms/iter → 40-iter refine {:.1}s",
            ms * 40.0 / 1000.0
        );
    }
}
