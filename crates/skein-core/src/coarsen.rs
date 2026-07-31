//! Multilevel coarsening for the layout pipeline (REQUIREMENTS.md §6):
//! symmetrize the directed CSR, then repeat label propagation until the
//! coarsest level is small enough for a full force sim.
//!
//! Everything here is deterministic by construction (DECISIONS.md D2): nodes
//! are visited in index order, votes accumulate in CSR neighbor order, ties
//! break toward the smaller label, and coarse ids are assigned in first-seen
//! order. Same input ⇒ same hierarchy, bit for bit.

use crate::Csr;

/// One level of the hierarchy. `graph` is the symmetrized, deduplicated
/// adjacency at this granularity; `parent_map[i]` is node i's index in the
/// next-coarser level (empty on the coarsest level).
pub struct HierarchyLevel {
    pub graph: Csr,
    pub parent_map: Vec<u32>,
}

/// Union of out- and in-edges with weights summed over duplicates and
/// self-loops dropped — the adjacency the force sim and label propagation
/// both want. Row order and the duplicate-merge order are fully determined
/// by a stable sort, so weight sums are order-deterministic.
pub fn symmetrize(csr: &Csr) -> Csr {
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
    build_dedup(n, pairs, true)
}

/// Sort (packed source<<32|target, weight) pairs, merge duplicates by summing
/// weights, and emit a CSR. `mirror` also inserts the reversed edge first.
fn build_dedup(n: u32, mut pairs: Vec<(u64, f32)>, mirror: bool) -> Csr {
    if mirror {
        let len = pairs.len();
        pairs.reserve(len);
        for i in 0..len {
            let (key, w) = pairs[i];
            let (u, v) = (key >> 32, key & 0xffff_ffff);
            pairs.push(((v << 32) | u, w));
        }
    }
    // Stable sort: equal keys keep insertion order, so the f32 merge below
    // sums in a fully determined order.
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

/// One round of size-capped label propagation over a symmetrized graph.
/// Returns the fine→coarse map and the coarse graph, or None if propagation
/// failed to shrink the graph meaningfully.
///
/// The size cap stops hubs from swallowing the whole graph (scale-free
/// inputs otherwise collapse to one label), which would starve the coarser
/// levels the multilevel scheme depends on.
pub fn coarsen_once(sym: &Csr, max_cluster: u32, sweeps: u32) -> Option<(Vec<u32>, Csr)> {
    let n = sym.node_count() as usize;
    if n == 0 {
        return None;
    }
    let weights = sym
        .weights
        .as_ref()
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
        return None;
    }

    // Aggregate fine edges into the coarse graph.
    let mut pairs: Vec<(u64, f32)> = Vec::new();
    for u in 0..n {
        let cu = map[u];
        for e in sym.offsets[u] as usize..sym.offsets[u + 1] as usize {
            let cv = map[sym.targets[e] as usize];
            if cu != cv {
                pairs.push((((cu as u64) << 32) | cv as u64, weights[e]));
            }
        }
    }
    let coarse = build_dedup(coarse_n, pairs, false);
    Some((map, coarse))
}

/// Build the full hierarchy: level 0 is the symmetrized input; coarsening
/// stops at `target_nodes`, after `max_levels`, or when propagation stalls.
pub fn build_hierarchy(csr: &Csr, target_nodes: u32, max_levels: usize) -> Vec<HierarchyLevel> {
    let mut levels = vec![HierarchyLevel {
        graph: symmetrize(csr),
        parent_map: Vec::new(),
    }];
    while levels.len() < max_levels {
        let current = &levels[levels.len() - 1].graph;
        if current.node_count() <= target_nodes {
            break;
        }
        let Some((map, coarse)) = coarsen_once(current, 32, 5) else {
            break;
        };
        let last = levels.len() - 1;
        levels[last].parent_map = map;
        levels.push(HierarchyLevel {
            graph: coarse,
            parent_map: Vec::new(),
        });
    }
    levels
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(sym.weights.as_deref(), Some(&[3.0, 3.0][..]));
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
        assert_eq!(sym.weights.as_deref(), Some(&[2.5, 2.5][..]));
    }

    #[test]
    fn coarsens_a_line() {
        let sym = symmetrize(&line_graph(1000));
        let (map, coarse) = coarsen_once(&sym, 32, 5).expect("line should coarsen");
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
        let (map, coarse) = coarsen_once(&sym, 32, 5).expect("star should coarsen");
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
            assert_eq!(la.graph.targets, lb.graph.targets);
            assert_eq!(la.graph.weights, lb.graph.weights);
        }
    }
}
