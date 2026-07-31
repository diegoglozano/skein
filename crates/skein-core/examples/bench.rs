//! Native micro-benchmark for the CI regression-ratio gate (DECISIONS.md D5).
//! Prints one JSON object; bench/compare-bench.mjs diffs it against the
//! committed baseline. Absolute numbers are machine-dependent — only ratios
//! against a baseline from the same machine class mean anything.
//!
//! Run: cargo run --release --example bench

use skein_core::{Csr, Interner};
use std::time::Instant;

/// Deterministic xorshift so every run interns the same ids.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
}

fn main() {
    let n: u64 = 1_000_000;
    let m: usize = 10_000_000;
    let mut rng = Rng(0x5eed);

    // Pre-render string ids the way a CSV would deliver them.
    let ids: Vec<String> = (0..n).map(|i| format!("user_{i:07}")).collect();

    let start = Instant::now();
    let mut interner = Interner::with_capacity(n as usize);
    let mut sources = Vec::with_capacity(m);
    let mut targets = Vec::with_capacity(m);
    for _ in 0..m {
        let s = (rng.next() % n) as usize;
        let t = (rng.next() % n) as usize;
        sources.push(interner.intern(ids[s].as_bytes()));
        targets.push(interner.intern(ids[t].as_bytes()));
    }
    let intern_secs = start.elapsed().as_secs_f64();
    let node_count = interner.len() as u32;

    let start = Instant::now();
    let csr = Csr::from_edges(node_count, &sources, &targets, None);
    let csr_secs = start.elapsed().as_secs_f64();

    assert_eq!(csr.edge_count(), m);
    println!(
        "{{\"nodes\":{},\"edges\":{},\"intern_secs\":{:.3},\"intern_meps\":{:.1},\"csr_secs\":{:.3},\"csr_meps\":{:.1}}}",
        node_count,
        m,
        intern_secs,
        (2 * m) as f64 / intern_secs / 1e6,
        csr_secs,
        m as f64 / csr_secs / 1e6,
    );
}
