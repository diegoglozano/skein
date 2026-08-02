//! Multilevel coarsening for the layout pipeline (REQUIREMENTS.md §6):
//! symmetrize the directed CSR, then repeat label propagation until the
//! coarsest level is small enough for a full force sim.
//!
//! Everything here is deterministic by construction (DECISIONS.md D2): nodes
//! are visited in index order, votes accumulate in CSR neighbor order, ties
//! break toward the smaller label, and coarse ids are assigned in first-seen
//! order. Same input ⇒ same hierarchy, bit for bit.

use std::io;
use std::ops::Range;

use crate::scratch::{HeapScratch, Scratch};
use crate::{Csr, CsrBuf, CsrView};

/// One level of the hierarchy. `graph` is the symmetrized, deduplicated
/// adjacency at this granularity; `parent_map[i]` is node i's index in the
/// next-coarser level (empty on the coarsest level).
pub struct HierarchyLevel {
    pub graph: CsrBuf,
    pub parent_map: Vec<u32>,
}

/// Union of out- and in-edges with weights summed over duplicates and
/// self-loops dropped — the adjacency the force sim and label propagation
/// both want. Row order and the duplicate-merge order are fully determined
/// by a stable sort, so weight sums are order-deterministic.
pub fn symmetrize(csr: &Csr) -> CsrBuf {
    symmetrize_view(csr.as_view())
}

/// [`symmetrize`] over a borrowed CSR — the entry point for an adjacency that
/// lives in a memory-mapped file rather than on the heap (D15).
pub fn symmetrize_view(csr: CsrView<'_>) -> CsrBuf {
    symmetrize_in(csr, &HeapScratch).expect("heap scratch cannot fail")
}

/// [`symmetrize_view`], with the output's edge-sized arrays placed by `scratch`
/// rather than always on the heap. See [`crate::scratch`] — this is the entry
/// point for a graph whose symmetrized adjacency does not fit in RAM (D16).
pub fn symmetrize_in(csr: CsrView<'_>, scratch: &dyn Scratch) -> io::Result<CsrBuf> {
    let n = csr.node_count();
    build_dedup_banded(n, scratch, |rows, out| {
        // Emission order matters (D2): every forward edge, then every mirror,
        // which is exactly the order the reference implementation pushed them
        // in before its global stable sort. Restricting to `rows` preserves it,
        // because it only drops triples the band would have ignored anyway.
        //
        // The forward pass indexes straight to the band; the mirror pass cannot
        // (a mirror's source is an arbitrary target) and must scan, but the
        // range check is inline here rather than a call into the builder.
        for u in rows.clone() {
            let start = csr.offsets[u as usize] as usize;
            let end = csr.offsets[u as usize + 1] as usize;
            for e in start..end {
                let v = csr.targets[e];
                if v != u {
                    out(u, v, csr.weights.map_or(1.0, |ws| ws[e]));
                }
            }
        }
        for u in 0..n {
            let start = csr.offsets[u as usize] as usize;
            let end = csr.offsets[u as usize + 1] as usize;
            for e in start..end {
                let v = csr.targets[e];
                if v != u && rows.contains(&v) {
                    out(v, u, csr.weights.map_or(1.0, |ws| ws[e]));
                }
            }
        }
    })
}

/// Bucket (source, target, weight) triples by source, sort each row by target,
/// merge duplicates by summing weights, and emit a CSR.
///
/// `emit` streams its triples rather than materialising them, and is called
/// **once per pass**: one counting pass, then one pass per band. It is handed
/// the row range that pass cares about and may skip triples outside it; for
/// everything it does emit, the order must be identical on every call.
///
/// **Two allocations, both `scratch`'s.** The only arrays that scale with edges
/// are the output's own `targets` and `weights`; everything else is node-sized.
/// The build writes each band's triples in place into the output arrays at their
/// pre-dedup positions, then sorts and merges each row forward over the same
/// region — dedup only ever shrinks a row, so the compacting write cursor never
/// overtakes the read position. That is what removed the intermediate array the
/// D15/N2 version still had (a `Vec<(u32, f32)>` of every triple, alive
/// alongside the output), halving peak memory again and letting the remaining
/// arrays be memory-mapped instead of resident.
///
/// **Bands** exist for locality, not for the total: a band is a run of
/// consecutive rows holding at most `scratch.band_len()` triples, and only that
/// band's region of the output is being written at any moment. On the heap that
/// is pointless, so `HeapScratch` uses one band and the emit count stays at two,
/// exactly as before. On a memory-mapped slab it bounds the dirty window, at the
/// cost of one extra pass over the input per band.
///
/// **Determinism (D2).** A global stable sort by the packed `source<<32|target`
/// key is exactly equivalent to bucketing by source and stable-sorting each row
/// by target: both yield rows in ascending source, targets ascending within a
/// row, and — critically for the `f32` weight merge below — duplicates in
/// emission order. Banding changes neither, because a band only restricts
/// *which* rows are filled, never the order of triples within a row. The
/// equivalence is verified against the original implementation in this module's
/// tests, which keep it as a reference, at several band sizes.
fn build_dedup_banded<F>(n: u32, scratch: &dyn Scratch, mut emit: F) -> io::Result<CsrBuf>
where
    F: FnMut(Range<u32>, &mut dyn FnMut(u32, u32, f32)),
{
    // Pass 1: how many triples land in each row. Kept (rather than turned into
    // a prefix sum in place) because each band needs the raw counts again to
    // find its row boundaries after filling.
    let mut counts = vec![0u32; n as usize];
    let mut total = 0u64;
    emit(0..n, &mut |source, _target, _weight| {
        counts[source as usize] += 1;
        total += 1;
    });
    // §4.2 makes CSR offsets `u32`, so this is the format's ceiling, not this
    // function's. Fail loudly rather than wrap (§8).
    assert!(
        total <= u32::MAX as u64,
        "{total} symmetrized arcs exceeds the u32 CSR offset limit"
    );
    let total = total as usize;
    let widest = counts.iter().copied().max().unwrap_or(0) as usize;

    let mut targets = scratch.alloc(total)?;
    let mut weights = scratch.alloc(total)?;

    let mut offsets = vec![0u32; n as usize + 1];
    // Per-row write cursors during a band's fill pass; afterwards each holds
    // that row's end, so its start is `cursor - counts[row]`.
    let mut cursor = vec![0u32; n as usize];
    // One row at a time, so the sort works on contiguous pairs rather than two
    // parallel slabs. Bounded by the widest row, not by the edge count.
    let mut row: Vec<(u32, f32)> = Vec::with_capacity(widest);

    {
        let out_t = targets.u32s_mut();
        let out_w = weights.f32s_mut();
        let band_len = scratch.band_len();
        // Where the *deduped* output has reached. Bands append to it in row
        // order, so the result is compact and needs no final pass.
        let mut write = 0usize;
        let mut lo = 0usize;
        while lo < n as usize {
            // Grow the band while it fits, but always take at least one row —
            // a single row wider than the budget has nowhere else to go.
            let mut hi = lo;
            let mut staged = 0usize;
            while hi < n as usize && (hi == lo || staged + counts[hi] as usize <= band_len) {
                staged += counts[hi] as usize;
                hi += 1;
            }

            let mut at = write;
            for (r, cur) in cursor[lo..hi].iter_mut().enumerate() {
                *cur = at as u32;
                at += counts[lo + r] as usize;
            }

            // The range is advisory — a caller that cannot cheaply restrict its
            // scan may emit anything, so the band still filters.
            emit(lo as u32..hi as u32, &mut |source, target, weight| {
                let source = source as usize;
                if source < lo || source >= hi {
                    return;
                }
                let slot = &mut cursor[source];
                out_t[*slot as usize] = target;
                out_w[*slot as usize] = weight;
                *slot += 1;
            });
            debug_assert_eq!(
                at,
                cursor[hi - 1] as usize,
                "emit produced a different number of triples than it counted"
            );

            for r in lo..hi {
                let end = cursor[r] as usize;
                let start = end - counts[r] as usize;
                row.clear();
                row.extend((start..end).map(|i| (out_t[i], out_w[i])));
                // Stable: equal targets keep emission order, matching the global
                // sort the reference implementation performed.
                row.sort_by_key(|&(target, _)| target);
                let mut i = 0;
                while i < row.len() {
                    let target = row[i].0;
                    let mut w = 0.0f32;
                    while i < row.len() && row[i].0 == target {
                        w += row[i].1;
                        i += 1;
                    }
                    // write <= start always: the band's staging began at `write`
                    // and dedup only removes entries.
                    out_t[write] = target;
                    out_w[write] = w;
                    write += 1;
                }
                offsets[r + 1] = write as u32;
            }
            lo = hi;
        }
        // Borrows of the slabs end here so they can be shrunk.
        targets.shrink_to(write);
        weights.shrink_to(write);
    }

    Ok(CsrBuf::from_parts(offsets, targets, weights))
}

/// One round of size-capped label propagation over a symmetrized graph.
/// Returns the fine→coarse map and the coarse graph, or None if propagation
/// failed to shrink the graph meaningfully.
///
/// The size cap stops hubs from swallowing the whole graph (scale-free
/// inputs otherwise collapse to one label), which would starve the coarser
/// levels the multilevel scheme depends on.
pub fn coarsen_once(sym: CsrView<'_>, max_cluster: u32, sweeps: u32) -> Option<(Vec<u32>, CsrBuf)> {
    coarsen_once_in(sym, max_cluster, sweeps, &HeapScratch).expect("heap scratch cannot fail")
}

/// [`coarsen_once`] with the coarse level's edge arrays placed by `scratch`.
///
/// Note what stays on the heap: labels, cluster sizes and the vote scratch are
/// all node-sized and randomly accessed, so they must be resident. The passes
/// over `sym` — both the propagation sweeps and the aggregation — walk it in row
/// order, which is why a memory-mapped level streams rather than thrashes.
pub fn coarsen_once_in(
    sym: CsrView<'_>,
    max_cluster: u32,
    sweeps: u32,
    scratch: &dyn Scratch,
) -> io::Result<Option<(Vec<u32>, CsrBuf)>> {
    let n = sym.node_count() as usize;
    if n == 0 {
        return Ok(None);
    }
    let weights = sym
        .weights
        .expect("coarsen_once expects a weighted (symmetrized) graph");

    let mut labels: Vec<u32> = (0..n as u32).collect();
    let mut cluster_size = vec![1u32; n];

    // Timestamped scratch so per-node vote gathering is O(degree).
    let mut vote_weight = vec![0.0f32; n];
    let mut vote_stamp = vec![0u32; n];
    let mut touched: Vec<u32> = Vec::new();
    let mut stamp = 0u32;

    for _ in 0..sweeps {
        let mut moves = 0u64;
        for i in 0..n {
            let start = sym.offsets[i] as usize;
            let end = sym.offsets[i + 1] as usize;
            if start == end {
                continue;
            }
            stamp += 1;
            touched.clear();
            for e in start..end {
                let label = labels[sym.targets[e] as usize];
                let li = label as usize;
                if vote_stamp[li] != stamp {
                    vote_stamp[li] = stamp;
                    vote_weight[li] = 0.0;
                    touched.push(label);
                }
                vote_weight[li] += weights[e];
            }
            let current = labels[i];
            let mut best = current;
            let mut best_w = f32::NEG_INFINITY;
            for &label in &touched {
                // A full cluster can't accept new members; staying is allowed.
                if label != current && cluster_size[label as usize] >= max_cluster {
                    continue;
                }
                let w = vote_weight[label as usize];
                if w > best_w || (w == best_w && label < best) {
                    best = label;
                    best_w = w;
                }
            }
            if best != current {
                cluster_size[current as usize] -= 1;
                cluster_size[best as usize] += 1;
                labels[i] = best;
                moves += 1;
            }
        }
        if moves == 0 {
            break;
        }
    }

    // Compact labels to dense coarse ids in first-seen order.
    let mut dense = vec![u32::MAX; n];
    let mut map = vec![0u32; n];
    let mut next = 0u32;
    for i in 0..n {
        let label = labels[i] as usize;
        if dense[label] == u32::MAX {
            dense[label] = next;
            next += 1;
        }
        map[i] = dense[label];
    }
    let coarse_n = next;
    // Meaningful shrink or bust (caller stops the hierarchy).
    if (coarse_n as usize) * 20 > n * 19 {
        return Ok(None);
    }

    // Aggregate fine edges into the coarse graph. Streamed for the same reason
    // symmetrize is: at the finest level this ran over every symmetrized edge.
    let coarse = build_dedup_banded(coarse_n, scratch, |rows, out| {
        for u in 0..n {
            let cu = map[u];
            // A whole fine row can be skipped when its cluster is outside the
            // band, which is what keeps a banded build from re-scanning the
            // entire level once per band.
            if !rows.contains(&cu) {
                continue;
            }
            for e in sym.offsets[u] as usize..sym.offsets[u + 1] as usize {
                let cv = map[sym.targets[e] as usize];
                if cu != cv {
                    out(cu, cv, weights[e]);
                }
            }
        }
    })?;
    Ok(Some((map, coarse)))
}

/// Build the full hierarchy: level 0 is the symmetrized input; coarsening
/// stops at `target_nodes`, after `max_levels`, or when propagation stalls.
pub fn build_hierarchy(csr: &Csr, target_nodes: u32, max_levels: usize) -> Vec<HierarchyLevel> {
    build_hierarchy_view(csr.as_view(), target_nodes, max_levels)
}

/// [`build_hierarchy`] over a borrowed CSR. Only the finest level reads the
/// input; every coarser level is owned data this function produces, so this is
/// the single place the mmap needs to reach (D15).
pub fn build_hierarchy_view(
    csr: CsrView<'_>,
    target_nodes: u32,
    max_levels: usize,
) -> Vec<HierarchyLevel> {
    build_hierarchy_in(csr, target_nodes, max_levels, &HeapScratch)
        .expect("heap scratch cannot fail")
}

/// [`build_hierarchy_view`] with every level's edge arrays placed by `scratch`.
///
/// This is the whole out-of-core entry point (D16): pass a
/// [`crate::MmapScratch`] and the hierarchy — dominated by the symmetrized
/// finest level, which stays live for the entire layout — lives in a file the
/// kernel can evict, not in anonymous memory it cannot.
pub fn build_hierarchy_in(
    csr: CsrView<'_>,
    target_nodes: u32,
    max_levels: usize,
    scratch: &dyn Scratch,
) -> io::Result<Vec<HierarchyLevel>> {
    let mut levels = vec![HierarchyLevel {
        graph: symmetrize_in(csr, scratch)?,
        parent_map: Vec::new(),
    }];
    while levels.len() < max_levels {
        let current = &levels[levels.len() - 1].graph;
        if current.node_count() <= target_nodes {
            break;
        }
        let Some((map, coarse)) = coarsen_once_in(current.as_view(), 32, 5, scratch)? else {
            break;
        };
        let last = levels.len() - 1;
        levels[last].parent_map = map;
        levels.push(HierarchyLevel {
            graph: coarse,
            parent_map: Vec::new(),
        });
    }
    Ok(levels)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pre-D15/N2 implementation, kept verbatim as the reference the
    /// counting-sort version must reproduce **bit for bit** — the weight merge
    /// is `f32` addition, so a different summation order is a different graph
    /// and would silently change every layout downstream (D2). Same discipline
    /// D11 used when replacing `cpu.ts`.
    fn build_dedup_reference(n: u32, mut pairs: Vec<(u64, f32)>, mirror: bool) -> Csr {
        if mirror {
            let len = pairs.len();
            pairs.reserve(len);
            for i in 0..len {
                let (key, w) = pairs[i];
                let (u, v) = (key >> 32, key & 0xffff_ffff);
                pairs.push(((v << 32) | u, w));
            }
        }
        pairs.sort_by_key(|&(key, _)| key);

        let mut offsets = vec![0u32; n as usize + 1];
        let mut targets = Vec::new();
        let mut weights = Vec::new();
        let mut i = 0;
        while i < pairs.len() {
            let key = pairs[i].0;
            let mut w = 0.0f32;
            while i < pairs.len() && pairs[i].0 == key {
                w += pairs[i].1;
                i += 1;
            }
            let source = (key >> 32) as u32;
            offsets[source as usize + 1] += 1;
            targets.push((key & 0xffff_ffff) as u32);
            weights.push(w);
        }
        for i in 1..offsets.len() {
            offsets[i] += offsets[i - 1];
        }
        Csr {
            offsets,
            targets,
            weights: Some(weights),
        }
    }

    /// `symmetrize` as it was before the rewrite.
    fn symmetrize_reference(csr: &Csr) -> Csr {
        let n = csr.node_count();
        let mut pairs: Vec<(u64, f32)> = Vec::with_capacity(2 * csr.edge_count());
        for u in 0..n {
            let start = csr.offsets[u as usize] as usize;
            let end = csr.offsets[u as usize + 1] as usize;
            for e in start..end {
                let v = csr.targets[e];
                if v == u {
                    continue;
                }
                let w = csr.weights.as_ref().map_or(1.0, |ws| ws[e]);
                pairs.push((((u as u64) << 32) | v as u64, w));
            }
        }
        build_dedup_reference(n, pairs, true)
    }

    fn assert_csr_identical(a: &CsrBuf, b: &Csr, what: &str) {
        assert_eq!(a.offsets, b.offsets, "{what}: offsets differ");
        assert_eq!(a.targets(), b.targets.as_slice(), "{what}: targets differ");
        // Bit comparison, not approximate: a different f32 summation order is
        // exactly what this is guarding against.
        let wb = b.weights.as_deref().expect("reference builds weights");
        assert_eq!(a.weights().len(), wb.len(), "{what}: weight lengths differ");
        for (i, (x, y)) in a.weights().iter().zip(wb).enumerate() {
            assert_eq!(x.to_bits(), y.to_bits(), "{what}: weight {i} differs");
        }
    }

    /// Every scratch policy worth exercising, paired with a label. Band sizes
    /// deliberately include ones far smaller than any test graph, so the banded
    /// path is the one under test rather than a single-band special case.
    fn scratches() -> Vec<(String, Box<dyn Scratch>)> {
        let mut out: Vec<(String, Box<dyn Scratch>)> = vec![("heap".into(), Box::new(HeapScratch))];
        for band in [1usize, 3, 17, 1024] {
            out.push((
                format!("banded({band})"),
                Box::new(TestBands {
                    band,
                    inner: HeapScratch,
                }),
            ));
        }
        #[cfg(not(target_arch = "wasm32"))]
        out.push((
            "mmap".into(),
            Box::new(crate::MmapScratch::new(std::env::temp_dir(), 1 << 16).min_mapped(0)),
        ));
        out
    }

    /// Heap slabs with a forced band size — separates "does banding change the
    /// output" from "does mmap change the output", which are different risks.
    struct TestBands {
        band: usize,
        inner: HeapScratch,
    }

    impl Scratch for TestBands {
        fn alloc(&self, len: usize) -> io::Result<Box<dyn crate::Slab>> {
            self.inner.alloc(len)
        }
        fn band_len(&self) -> usize {
            self.band
        }
        fn label(&self) -> &'static str {
            "test-bands"
        }
    }

    /// xorshift64* — a local generator so these cases don't depend on the
    /// layout module's RNG.
    fn rng_graph(n: u32, m: usize, seed: u64, weighted: bool) -> Csr {
        let mut s = seed | 1;
        let mut next = || {
            s ^= s >> 12;
            s ^= s << 25;
            s ^= s >> 27;
            s.wrapping_mul(0x2545_f491_4f6c_dd1d)
        };
        let mut sources = Vec::with_capacity(m);
        let mut targets = Vec::with_capacity(m);
        let mut weights = Vec::with_capacity(m);
        for _ in 0..m {
            sources.push((next() % u64::from(n)) as u32);
            targets.push((next() % u64::from(n)) as u32);
            // Small integral weights make duplicate runs common, which is the
            // case where summation order could show up.
            weights.push((next() % 7) as f32 + 0.5);
        }
        Csr::from_edges(
            n,
            &sources,
            &targets,
            weighted.then_some(weights.as_slice()),
        )
    }

    #[test]
    fn counting_sort_symmetrize_matches_the_reference() {
        // Dense duplicates, self-loops, hubs and isolated nodes all appear
        // across these shapes.
        for &(n, m) in &[(8u32, 40usize), (64, 500), (200, 3000), (1000, 20000)] {
            for weighted in [false, true] {
                let csr = rng_graph(n, m, 0x5eed ^ u64::from(n), weighted);
                let want = symmetrize_reference(&csr);
                // Every storage policy must reproduce it bit for bit: where the
                // arrays live is not allowed to be observable (D2/D16).
                for (label, scratch) in scratches() {
                    let got = symmetrize_in(csr.as_view(), scratch.as_ref()).unwrap();
                    assert_csr_identical(
                        &got,
                        &want,
                        &format!("n={n} m={m} weighted={weighted} scratch={label}"),
                    );
                }
            }
        }
    }

    #[test]
    fn counting_sort_handles_hubs_and_empty_rows() {
        // One hub every node points at, plus nodes with no edges at all.
        let n = 50u32;
        let sources: Vec<u32> = (1..n).collect();
        let targets: Vec<u32> = vec![0; (n - 1) as usize];
        let csr = Csr::from_edges(n + 10, &sources, &targets, None);
        let want = symmetrize_reference(&csr);
        // The hub's row is far wider than the smallest band here, which is the
        // case where a band must still take a whole row rather than split it.
        for (label, scratch) in scratches() {
            let got = symmetrize_in(csr.as_view(), scratch.as_ref()).unwrap();
            assert_csr_identical(&got, &want, &format!("hub scratch={label}"));
        }
    }

    #[test]
    fn counting_sort_coarsen_matches_reference_hierarchy() {
        // coarsen_once also switched to the counting-sort dedup; verify the
        // whole hierarchy it produces is unchanged.
        let csr = rng_graph(2000, 30000, 0xc0ffee, true);
        let sym = symmetrize(&csr);
        let (map, _) = coarsen_once(sym.as_view(), 32, 5).expect("coarsens");

        let weights = sym.weights();
        let mut pairs: Vec<(u64, f32)> = Vec::new();
        let coarse_n = map.iter().copied().max().unwrap() + 1;
        for u in 0..sym.node_count() as usize {
            let cu = map[u];
            for e in sym.offsets[u] as usize..sym.offsets[u + 1] as usize {
                let cv = map[sym.targets()[e] as usize];
                if cu != cv {
                    pairs.push((((cu as u64) << 32) | cv as u64, weights[e]));
                }
            }
        }
        let want = build_dedup_reference(coarse_n, pairs, false);
        for (label, scratch) in scratches() {
            let (got_map, coarse) = coarsen_once_in(sym.as_view(), 32, 5, scratch.as_ref())
                .unwrap()
                .expect("coarsens");
            assert_eq!(got_map, map, "coarse map scratch={label}");
            assert_csr_identical(&coarse, &want, &format!("coarse scratch={label}"));
        }
    }

    /// The whole point of D16: a hierarchy built out-of-core must be the same
    /// hierarchy, level for level and bit for bit. A layout that differed by a
    /// single `f32` would be a different picture (D2), which is exactly the
    /// promise the store's round trip already makes.
    #[test]
    fn every_scratch_builds_the_same_hierarchy() {
        let csr = rng_graph(5000, 60000, 0xd16, true);
        let want = build_hierarchy(&csr, 50, 10);
        assert!(want.len() >= 3, "need a multi-level hierarchy to be a test");

        for (label, scratch) in scratches() {
            let got = build_hierarchy_in(csr.as_view(), 50, 10, scratch.as_ref()).unwrap();
            assert_eq!(got.len(), want.len(), "level count scratch={label}");
            for (li, (g, w)) in got.iter().zip(&want).enumerate() {
                assert_eq!(g.parent_map, w.parent_map, "L{li} map scratch={label}");
                assert_csr_identical(&g.graph, &w.graph.to_csr(), &format!("L{li} {label}"));
            }
        }
    }

    #[test]
    fn degenerate_graphs_survive_every_scratch() {
        // No rows at all, and rows with nothing in them: the band loop, the
        // zero-length allocation and the `hi - 1` index all have to hold.
        let cases: [(&str, Csr); 3] = [
            ("empty", Csr::from_edges(0, &[], &[], None)),
            ("no edges", Csr::from_edges(5, &[], &[], None)),
            ("self-loop only", Csr::from_edges(3, &[1], &[1], None)),
        ];
        for (what, csr) in cases {
            for (label, scratch) in scratches() {
                let got = symmetrize_in(csr.as_view(), scratch.as_ref()).unwrap();
                assert_eq!(got.node_count(), csr.node_count(), "{what} {label}: nodes");
                assert_eq!(got.edge_count(), 0, "{what} {label}: edges");
                assert!(got.offsets.iter().all(|&o| o == 0), "{what} {label}");
            }
        }
    }

    fn line_graph(n: u32) -> Csr {
        let sources: Vec<u32> = (0..n - 1).collect();
        let targets: Vec<u32> = (1..n).collect();
        Csr::from_edges(n, &sources, &targets, None)
    }

    #[test]
    fn symmetrize_mirrors_and_dedupes() {
        // 0→1 twice and 1→0 once must merge into one edge each way, w=3.
        let csr = Csr::from_edges(2, &[0, 0, 1], &[1, 1, 0], None);
        let sym = symmetrize(&csr);
        assert_eq!(sym.neighbors(0), &[1]);
        assert_eq!(sym.neighbors(1), &[0]);
        assert_eq!(sym.weights(), &[3.0, 3.0]);
    }

    #[test]
    fn symmetrize_drops_self_loops() {
        let csr = Csr::from_edges(2, &[0, 1], &[0, 1], None);
        let sym = symmetrize(&csr);
        assert_eq!(sym.edge_count(), 0);
    }

    #[test]
    fn symmetrize_carries_weights() {
        let csr = Csr::from_edges(2, &[0], &[1], Some(&[2.5]));
        let sym = symmetrize(&csr);
        assert_eq!(sym.weights(), &[2.5, 2.5]);
    }

    #[test]
    fn coarsens_a_line() {
        let sym = symmetrize(&line_graph(1000));
        let (map, coarse) = coarsen_once(sym.as_view(), 32, 5).expect("line should coarsen");
        assert_eq!(map.len(), 1000);
        assert!(coarse.node_count() < 500, "got {}", coarse.node_count());
        // Every fine edge maps to a coarse edge or an intra-cluster pair.
        assert!(coarse.edge_count() > 0);
    }

    #[test]
    fn cluster_cap_holds() {
        // A star: hub 0 with 200 leaves. Without the cap everything joins one
        // cluster; with cap 32 we need ≥ ceil(201/32) clusters.
        let sources: Vec<u32> = (1..=200).collect();
        let targets = vec![0u32; 200];
        let sym = symmetrize(&Csr::from_edges(201, &sources, &targets, None));
        let (map, coarse) = coarsen_once(sym.as_view(), 32, 5).expect("star should coarsen");
        let mut counts = vec![0u32; coarse.node_count() as usize];
        for &c in &map {
            counts[c as usize] += 1;
        }
        assert!(
            counts.iter().all(|&c| c <= 32),
            "max {:?}",
            counts.iter().max()
        );
        assert!(coarse.node_count() >= 7);
    }

    #[test]
    fn hierarchy_reaches_target() {
        let levels = build_hierarchy(&line_graph(10_000), 100, 10);
        assert!(levels.len() >= 2);
        let coarsest = &levels[levels.len() - 1].graph;
        assert!(
            coarsest.node_count() <= 700,
            "coarsest {}",
            coarsest.node_count()
        );
        // Interior levels all carry a map covering their nodes.
        for level in &levels[..levels.len() - 1] {
            assert_eq!(level.parent_map.len(), level.graph.node_count() as usize);
        }
        assert!(levels.last().unwrap().parent_map.is_empty());
    }

    #[test]
    fn deterministic() {
        let csr = {
            // Pseudo-random graph, fixed seed.
            let mut s = 0x5eedu64;
            let mut next = || {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                s
            };
            let sources: Vec<u32> = (0..20_000).map(|_| (next() % 2000) as u32).collect();
            let targets: Vec<u32> = (0..20_000).map(|_| (next() % 2000) as u32).collect();
            Csr::from_edges(2000, &sources, &targets, None)
        };
        let a = build_hierarchy(&csr, 50, 10);
        let b = build_hierarchy(&csr, 50, 10);
        assert_eq!(a.len(), b.len());
        for (la, lb) in a.iter().zip(&b) {
            assert_eq!(la.parent_map, lb.parent_map);
            assert_eq!(la.graph.offsets, lb.graph.offsets);
            assert_eq!(la.graph.targets(), lb.graph.targets());
            assert_eq!(la.graph.weights(), lb.graph.weights());
        }
    }
}
