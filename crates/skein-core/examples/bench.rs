//! Native micro-benchmark for the CI regression-ratio gate (DECISIONS.md D5).
//! Prints one JSON object; bench/compare-bench.mjs diffs it against the
//! committed baseline. Absolute numbers are machine-dependent — only ratios
//! against a baseline from the same machine class mean anything.
//!
//! Run: cargo run --release --example bench

use skein_core::{build_hierarchy, Csr, EdgeIngest, IngestConfig, Interner};
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

    // Streaming CSV ingest (scanner + interner together), fed in chunks the
    // size File.stream() typically delivers. Same edges as above, rendered
    // the way the fixture generator writes them.
    let mut rng = Rng(0x5eed);
    let mut csv = String::with_capacity(m * 18 + 16);
    csv.push_str("source,target\n");
    for _ in 0..m {
        let s = rng.next() % n;
        let t = rng.next() % n;
        csv.push_str(&format!("user_{s:07},user_{t:07}\n"));
    }
    let bytes = csv.as_bytes();

    let start = Instant::now();
    let mut ingest = EdgeIngest::new(IngestConfig::default(), n as usize);
    for chunk in bytes.chunks(1 << 20) {
        ingest.push_chunk(chunk);
    }
    let csv_secs = start.elapsed().as_secs_f64();
    let out = ingest.finish();
    assert_eq!(out.csr.edge_count(), m);
    assert_eq!(out.csr.node_count(), node_count);
    assert_eq!(out.skipped, 0);

    // Multilevel coarsening (§6): symmetrize + label-propagation hierarchy.
    let start = Instant::now();
    let levels = build_hierarchy(&csr, 10_000, 12);
    let hierarchy_secs = start.elapsed().as_secs_f64();
    assert!(levels.len() > 1);

    println!(
        "{{\"nodes\":{},\"edges\":{},\"intern_secs\":{:.3},\"intern_meps\":{:.1},\"csr_secs\":{:.3},\"csr_meps\":{:.1},\"csv_secs\":{:.3},\"csv_mbps\":{:.1},\"hierarchy_secs\":{:.3},\"hierarchy_levels\":{}}}",
        node_count,
        m,
        intern_secs,
        (2 * m) as f64 / intern_secs / 1e6,
        csr_secs,
        m as f64 / csr_secs / 1e6,
        csv_secs,
        bytes.len() as f64 / csv_secs / 1e6,
        hierarchy_secs,
        levels.len(),
    );
}
