//! Hierarchy build, one scratch tier per process — the D16 measurement harness.
//!
//! Peak RSS is a process-lifetime high-water mark, so measuring two tiers in one
//! run measures only the larger. Hence one mode per invocation:
//!
//! ```sh
//! cargo run --release --example out_of_core -- bench/fixtures/medium.csv --scratch heap
//! cargo run --release --example out_of_core -- bench/fixtures/medium.csv --scratch mmap
//! ```
//!
//! It prints a checksum of every level, which is the point as much as the
//! timings are: the two tiers must agree bit for bit or the out-of-core path is
//! producing a different graph (D2).
//!
//! On Linux it reads peak RSS from `/proc/self/status` and resets the high-water
//! mark before the hierarchy build, so the reported peak excludes ingest. On
//! macOS `/proc` does not exist — wrap the whole run in `/usr/bin/time -l`,
//! which is how D15's numbers were taken.
//!
//! Resident memory is not the number to read here, and running it unconstrained
//! will suggest the tiers are identical. Under no memory pressure the kernel
//! keeps mapped pages resident, so RSS is the same either way; the difference is
//! that those pages *can* be evicted. Constrain anonymous memory to see it —
//! `ulimit -d` bounds anonymous mappings and deliberately does not bound
//! file-backed ones:
//!
//! ```sh
//! ( ulimit -d 300000; ... --scratch heap )   # aborts at 1M/10M
//! ( ulimit -d 300000; ... --scratch mmap )   # completes, same checksums
//! ```

use std::fs::File;
use std::io::{BufReader, Read};
use std::time::Instant;

use skein_core::{
    build_hierarchy_in, Csr, EdgeIngest, HeapScratch, IngestConfig, MmapScratch, Scratch,
};

/// Same as skein-native's, so the shapes are comparable rather than merely
/// similar.
const HIERARCHY_TARGET_NODES: u32 = 10_000;
const HIERARCHY_MAX_LEVELS: usize = 12;

/// FNV-1a over the level's bytes. Cheap, and sensitive to a single flipped
/// mantissa bit, which is the failure this is watching for.
fn checksum(offsets: &[u32], targets: &[u32], weights: &[f32]) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    let mut eat = |v: u32| {
        for b in v.to_le_bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x100_0000_01b3);
        }
    };
    for &v in offsets {
        eat(v);
    }
    for &v in targets {
        eat(v);
    }
    for &v in weights {
        eat(v.to_bits());
    }
    h
}

#[cfg(target_os = "linux")]
mod rss {
    fn field(name: &str) -> Option<u64> {
        let status = std::fs::read_to_string("/proc/self/status").ok()?;
        for line in status.lines() {
            if let Some(rest) = line.strip_prefix(name) {
                return rest
                    .trim_start_matches(':')
                    .split_whitespace()
                    .next()?
                    .parse()
                    .ok();
            }
        }
        None
    }

    pub fn peak_mb() -> Option<f64> {
        field("VmHWM").map(|kb| kb as f64 / 1024.0)
    }

    pub fn current_mb() -> Option<f64> {
        field("VmRSS").map(|kb| kb as f64 / 1024.0)
    }

    /// Reset the peak-RSS high-water mark to the current RSS, so what follows is
    /// measured on its own rather than under ingest's shadow.
    pub fn reset_peak() {
        let _ = std::fs::write("/proc/self/clear_refs", "5");
    }
}

#[cfg(not(target_os = "linux"))]
mod rss {
    pub fn peak_mb() -> Option<f64> {
        None
    }
    pub fn current_mb() -> Option<f64> {
        None
    }
    pub fn reset_peak() {}
}

fn show(label: &str) {
    match (rss::current_mb(), rss::peak_mb()) {
        (Some(cur), Some(peak)) => {
            println!("  rss {label:<22} {cur:>8.0} MB   peak {peak:>8.0} MB")
        }
        _ => println!("  rss {label:<22} (wrap in /usr/bin/time -l on macOS)"),
    }
}

fn ingest(path: &str) -> std::io::Result<Csr> {
    let mut reader = BufReader::with_capacity(1 << 20, File::open(path)?);
    let mut ingest = EdgeIngest::new(IngestConfig::default(), 1 << 16);
    let mut buf = vec![0u8; 1 << 22];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        ingest.push_chunk(&buf[..n]);
    }
    Ok(ingest.finish().csr)
}

fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut path = None;
    let mut mode = "heap".to_string();
    let mut band_mb = 256usize;
    let mut scratch_dir: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--scratch" => {
                i += 1;
                mode = args[i].clone();
            }
            "--band-mb" => {
                i += 1;
                band_mb = args[i].parse().expect("--band-mb N");
            }
            "--scratch-dir" => {
                i += 1;
                scratch_dir = Some(args[i].clone());
            }
            other => path = Some(other.to_string()),
        }
        i += 1;
    }
    let Some(path) = path else {
        eprintln!(
            "usage: out_of_core <edges.csv> [--scratch heap|mmap] [--band-mb N] \
             [--scratch-dir DIR]"
        );
        std::process::exit(2);
    };

    let t0 = Instant::now();
    let csr = ingest(&path)?;
    println!(
        "{path}: {} nodes, {} edges, ingested in {:.2} s",
        csr.node_count(),
        csr.edge_count(),
        t0.elapsed().as_secs_f64()
    );
    show("after ingest");

    let scratch: Box<dyn Scratch> = match mode.as_str() {
        "heap" => Box::new(HeapScratch),
        "mmap" => {
            // Beside the input, not in `/tmp`: on most Linux installs `/tmp` is
            // tmpfs, whose pages are backed by *swap* rather than a disk. Putting
            // the scratch there would look like it worked and evict nothing,
            // which is the quiet failure this whole change is trying to avoid.
            let dir = scratch_dir.unwrap_or_else(|| {
                std::path::Path::new(&path)
                    .parent()
                    .map(|d| d.to_string_lossy().into_owned())
                    .unwrap_or_else(|| ".".into())
            });
            println!("scratch dir: {dir}");
            Box::new(
                MmapScratch::new(dir, band_mb << 20)
                    // The finest level is what this is about; the coarse ones are
                    // small enough that a file per level is pure overhead.
                    .min_mapped(1 << 20),
            )
        }
        other => panic!("unknown scratch {other}"),
    };
    println!("scratch: {} ({band_mb} MB bands)", scratch.label());

    // Everything above is setup; the high-water mark from here is the number.
    rss::reset_peak();
    let t1 = Instant::now();
    let levels = build_hierarchy_in(
        csr.as_view(),
        HIERARCHY_TARGET_NODES,
        HIERARCHY_MAX_LEVELS,
        scratch.as_ref(),
    )?;
    let secs = t1.elapsed().as_secs_f64();

    println!("hierarchy: {} levels in {secs:.2} s", levels.len());
    for (i, level) in levels.iter().enumerate() {
        println!(
            "  L{i:<2} {:>10} nodes {:>12} arcs   checksum {:016x}",
            level.graph.node_count(),
            level.graph.edge_count(),
            checksum(
                &level.graph.offsets,
                level.graph.targets(),
                level.graph.weights()
            ),
        );
    }
    show("hierarchy built");
    Ok(())
}
