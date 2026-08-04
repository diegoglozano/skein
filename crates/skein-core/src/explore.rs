//! Neighbourhood and degree queries for the M4 explore surface
//! (REQUIREMENTS.md §10: hover, selection, "expand k hops").
//!
//! The stored CSR is directed, but an edge list read as a network is
//! undirected: `n9999 -> n1127` makes the two adjacent regardless of which
//! column each landed in. So both queries here treat the graph as symmetric
//! without materialising a symmetric copy — [`crate::symmetrize`] allocates a
//! second CSR (another 40 MB of targets at the §9 top tier) and is worth it
//! for the layout hierarchy, which walks the adjacency thousands of times, but
//! not for a click-rate query that walks it once.
//!
//! Flat buffers only (§4.2): dedup uses a bitmap over node indices, not a set
//! of boxed integers, so a hub with a million neighbours costs n/8 bytes and
//! no allocation per neighbour.

/// Total degree (out + in) for every node. Self-loops count twice, which is
/// the usual convention and keeps `sum(degrees) == 2 * edge_count`.
pub fn total_degrees(offsets: &[u32], targets: &[u32]) -> Vec<u32> {
    let n = offsets.len() - 1;
    let mut degrees = vec![0u32; n];
    for node in 0..n {
        degrees[node] = offsets[node + 1] - offsets[node];
    }
    for &t in targets {
        degrees[t as usize] += 1;
    }
    degrees
}

/// A k-hop neighbourhood, as [`khop`] returns it.
pub struct Neighborhood {
    /// Nodes within the hop limit, ascending, truncated to the caller's `cap`.
    /// The seed is never included, so a self-loop does not make a node its own
    /// neighbour.
    pub nodes: Vec<u32>,
    /// BFS-tree parent of each entry in `nodes`, same length. Every
    /// `(parent, node)` pair is an edge that exists in the graph — which is the
    /// point: past one hop, a star drawn from the seed to each member would
    /// draw lines that are not edges.
    pub parents: Vec<u32>,
    /// Distinct nodes found before truncation. The UI needs the honest count
    /// even when it only lists a prefix.
    pub total: usize,
    /// One byte per node: 1 for the seed and everything within the hop limit.
    /// Uncapped by design — this is what "isolate the subgraph" hides against,
    /// and isolating only the first `cap` members would silently show a
    /// different graph than the count above claims.
    pub mask: Vec<u8>,
}

/// Everything within `hops` hops of `node`, ignoring edge direction.
///
/// One level-synchronous BFS. Each level costs a single pass over the whole
/// CSR rather than a per-node lookup, because the stored graph is directed and
/// in-edges have no index: finding what points *at* a frontier is a scan
/// either way, so the scan is shared across the whole frontier. That makes the
/// walk O(hops * edges) with no reverse index resident — [`crate::symmetrize`]
/// would allocate a second CSR (another 40 MB of targets at the §9 top tier)
/// to save a few of those passes, which is worth it for the layout hierarchy
/// that walks the adjacency thousands of times and not for a query the user
/// waits on once.
///
/// Node-sized scratch only (§4.2): three bitmaps and the parent array, so a
/// hub with a million neighbours costs no allocation per neighbour.
pub fn khop(offsets: &[u32], targets: &[u32], node: u32, hops: u32, cap: usize) -> Neighborhood {
    let n = offsets.len() - 1;
    let mut mask = vec![0u8; n];
    if node as usize >= n || hops == 0 {
        // Out of range gets an all-zero mask; the seed is not in the graph, so
        // there is nothing to isolate. `hops == 0` still marks the seed, which
        // is the honest reading of "isolate zero hops around this node".
        if (node as usize) < n {
            mask[node as usize] = 1;
        }
        return Neighborhood {
            nodes: Vec::new(),
            parents: Vec::new(),
            total: 0,
            mask,
        };
    }

    let words = n.div_ceil(64);
    let bit = |set: &[u64], v: usize| set[v / 64] & (1u64 << (v % 64)) != 0;
    let set_bit = |set: &mut [u64], v: usize| set[v / 64] |= 1u64 << (v % 64);

    // `seen` is dedup and the answer both: an edge can appear in both
    // directions, and a row may contain duplicates if the source file did.
    let mut seen = vec![0u64; words];
    let mut frontier = vec![0u64; words];
    let mut parent = vec![u32::MAX; n];
    set_bit(&mut seen, node as usize);
    set_bit(&mut frontier, node as usize);

    let mut total = 0usize;
    for _ in 0..hops {
        let mut next = vec![0u64; words];
        let mut added = 0usize;
        for src in 0..n {
            let src_in_frontier = bit(&frontier, src);
            for e in offsets[src]..offsets[src + 1] {
                let t = targets[e as usize] as usize;
                // Both directions, both discovered by the same pass. Ties go
                // to the lower source index because the scan is ascending,
                // which keeps the tree — and so the overlay — deterministic
                // (D2) rather than dependent on traversal luck.
                if src_in_frontier && !bit(&seen, t) {
                    set_bit(&mut seen, t);
                    set_bit(&mut next, t);
                    parent[t] = src as u32;
                    added += 1;
                }
                if bit(&frontier, t) && !bit(&seen, src) {
                    set_bit(&mut seen, src);
                    set_bit(&mut next, src);
                    parent[src] = t as u32;
                    added += 1;
                }
            }
        }
        total += added;
        // A component smaller than the hop limit stops paying for the rest.
        if added == 0 {
            break;
        }
        frontier = next;
    }

    // Ascending order makes the sidebar list stable across runs (D2) and is
    // free: walk the bitmap rather than sorting the hits.
    let mut nodes = Vec::with_capacity(total.min(cap));
    let mut parents = Vec::with_capacity(total.min(cap));
    for (word_at, &word) in seen.iter().enumerate() {
        let mut bits = word;
        while bits != 0 {
            let v = word_at * 64 + bits.trailing_zeros() as usize;
            bits &= bits - 1;
            // The mask is finished even after the list fills: it is uncapped,
            // so this walk cannot stop early the way the old 1-hop one did.
            mask[v] = 1;
            if v != node as usize && nodes.len() < cap {
                nodes.push(v as u32);
                parents.push(parent[v]);
            }
        }
    }

    Neighborhood {
        nodes,
        parents,
        total,
        mask,
    }
}

/// The 1-hop neighbourhood of `node`, ignoring edge direction: [`khop`] at one
/// hop, where every parent is the seed itself.
pub fn neighbors(offsets: &[u32], targets: &[u32], node: u32, cap: usize) -> (Vec<u32>, usize) {
    let found = khop(offsets, targets, node, 1, cap);
    (found.nodes, found.total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Csr;

    /// 0->1, 0->2, 1->2, 3->0, plus the self-loop 2->2.
    fn fixture() -> Csr {
        Csr::from_edges(4, &[0, 0, 1, 3, 2], &[1, 2, 2, 0, 2], None)
    }

    #[test]
    fn degrees_count_both_directions() {
        let csr = fixture();
        let d = total_degrees(&csr.offsets, &csr.targets);
        // 0: out 1,2 + in from 3        = 3
        // 1: out 2   + in from 0        = 2
        // 2: out 2   + in from 0,1,2    = 4
        // 3: out 0   + in from none     = 1
        assert_eq!(d, vec![3, 2, 4, 1]);
        assert_eq!(d.iter().sum::<u32>() as usize, 2 * csr.targets.len());
    }

    #[test]
    fn neighbors_ignore_direction_and_self_loops() {
        let csr = fixture();
        // Node 0 points at 1 and 2, and is pointed at by 3.
        assert_eq!(
            neighbors(&csr.offsets, &csr.targets, 0, 10),
            (vec![1, 2, 3], 3)
        );
        // Node 2 is reached from 0 and 1; its own self-loop is not a neighbour.
        assert_eq!(
            neighbors(&csr.offsets, &csr.targets, 2, 10),
            (vec![0, 1], 2)
        );
        // Node 3 only has an out-edge.
        assert_eq!(neighbors(&csr.offsets, &csr.targets, 3, 10), (vec![0], 1));
    }

    #[test]
    fn duplicate_edges_are_deduped_once() {
        // The same pair listed twice, and again reversed.
        let csr = Csr::from_edges(2, &[0, 0, 1], &[1, 1, 0], None);
        assert_eq!(neighbors(&csr.offsets, &csr.targets, 0, 10), (vec![1], 1));
    }

    #[test]
    fn cap_truncates_but_total_stays_honest() {
        // Star: 0 connected to 1..=8.
        let sources: Vec<u32> = vec![0; 8];
        let targets: Vec<u32> = (1..=8).collect();
        let csr = Csr::from_edges(9, &sources, &targets, None);
        let (list, total) = neighbors(&csr.offsets, &csr.targets, 0, 3);
        assert_eq!(list, vec![1, 2, 3]);
        assert_eq!(total, 8, "cap must not change the reported count");
    }

    #[test]
    fn isolated_and_out_of_range_nodes() {
        let csr = Csr::from_edges(3, &[0], &[1], None);
        assert_eq!(
            neighbors(&csr.offsets, &csr.targets, 2, 10),
            (Vec::new(), 0)
        );
        assert_eq!(
            neighbors(&csr.offsets, &csr.targets, 99, 10),
            (Vec::new(), 0)
        );
    }

    /// A path 0—1—2—3—4, so hop distance is unambiguous.
    fn path(len: u32) -> Csr {
        let sources: Vec<u32> = (0..len - 1).collect();
        let targets: Vec<u32> = (1..len).collect();
        Csr::from_edges(len, &sources, &targets, None)
    }

    #[test]
    fn hops_reach_exactly_that_far() {
        let csr = path(5);
        for (hops, expected) in [(1u32, vec![1u32]), (2, vec![1, 2]), (3, vec![1, 2, 3])] {
            let found = khop(&csr.offsets, &csr.targets, 0, hops, 100);
            assert_eq!(found.nodes, expected, "at {hops} hops");
            assert_eq!(found.total, expected.len());
        }
    }

    #[test]
    fn hops_walk_against_edge_direction_too() {
        // 0 <- 1 <- 2: reachable from 0 only by ignoring direction.
        let csr = Csr::from_edges(3, &[1, 2], &[0, 1], None);
        let found = khop(&csr.offsets, &csr.targets, 0, 2, 100);
        assert_eq!(found.nodes, vec![1, 2]);
        assert_eq!(found.parents, vec![0, 1], "2 is reached through 1, not 0");
    }

    #[test]
    fn parents_are_real_edges() {
        let csr = path(5);
        let found = khop(&csr.offsets, &csr.targets, 0, 4, 100);
        assert_eq!(found.nodes, vec![1, 2, 3, 4]);
        assert_eq!(found.parents, vec![0, 1, 2, 3]);
        for (&node, &parent) in found.nodes.iter().zip(&found.parents) {
            let adjacent = |a: u32, b: u32| {
                (csr.offsets[a as usize]..csr.offsets[a as usize + 1])
                    .any(|e| csr.targets[e as usize] == b)
            };
            assert!(
                adjacent(parent, node) || adjacent(node, parent),
                "{parent}->{node} is not an edge"
            );
        }
    }

    #[test]
    fn more_hops_than_the_component_is_wide_terminates() {
        let csr = path(4);
        let found = khop(&csr.offsets, &csr.targets, 0, 1000, 100);
        assert_eq!(found.nodes, vec![1, 2, 3]);
        // The fourth node of a 4-node path is 3 hops out; the rest of the
        // budget must find nothing rather than re-walking.
        assert_eq!(found.total, 3);
    }

    #[test]
    fn other_components_are_never_reached() {
        // 0—1 and 2—3, disjoint.
        let csr = Csr::from_edges(4, &[0, 2], &[1, 3], None);
        let found = khop(&csr.offsets, &csr.targets, 0, 10, 100);
        assert_eq!(found.nodes, vec![1]);
        assert_eq!(found.mask, vec![1, 1, 0, 0]);
    }

    #[test]
    fn zero_hops_is_the_seed_alone() {
        let csr = path(4);
        let found = khop(&csr.offsets, &csr.targets, 1, 0, 100);
        assert!(found.nodes.is_empty());
        assert_eq!(found.total, 0);
        // Isolating zero hops leaves the selected node standing, not nothing.
        assert_eq!(found.mask, vec![0, 1, 0, 0]);
    }

    #[test]
    fn the_mask_covers_the_seed_and_ignores_the_cap() {
        // Star: 0 connected to 1..=8, listed three at a time.
        let sources: Vec<u32> = vec![0; 8];
        let targets: Vec<u32> = (1..=8).collect();
        let csr = Csr::from_edges(9, &sources, &targets, None);
        let found = khop(&csr.offsets, &csr.targets, 0, 1, 3);
        assert_eq!(found.nodes, vec![1, 2, 3], "the list is capped");
        assert_eq!(found.parents.len(), 3, "parents stay aligned with nodes");
        assert_eq!(found.total, 8, "the count stays honest");
        assert_eq!(found.mask, vec![1; 9], "and the mask is not capped at all");
    }

    #[test]
    fn out_of_range_seed_masks_nothing() {
        let csr = path(3);
        let found = khop(&csr.offsets, &csr.targets, 99, 3, 100);
        assert!(found.nodes.is_empty());
        assert_eq!(found.mask, vec![0, 0, 0]);
    }

    #[test]
    fn neighbors_span_word_boundaries() {
        // Neighbours either side of the 64-bit bitmap word boundary.
        let sources = vec![0u32; 3];
        let targets = vec![1u32, 64, 130];
        let csr = Csr::from_edges(200, &sources, &targets, None);
        assert_eq!(
            neighbors(&csr.offsets, &csr.targets, 0, 10),
            (vec![1, 64, 130], 3)
        );
    }
}
