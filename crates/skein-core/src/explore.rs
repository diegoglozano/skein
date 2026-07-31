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

/// The 1-hop neighbourhood of `node`, ignoring edge direction.
///
/// Returns the neighbours in ascending index order, truncated to `cap`, plus
/// the true total before truncation — the UI needs the honest count even when
/// it only draws a prefix (no silent caps). `node` itself is never included,
/// so a self-loop does not make a node its own neighbour.
///
/// Out-edges are a CSR row; in-edges cost a scan of `targets`, which is the
/// price of not keeping a reverse index resident.
pub fn neighbors(offsets: &[u32], targets: &[u32], node: u32, cap: usize) -> (Vec<u32>, usize) {
    let n = offsets.len() - 1;
    if node as usize >= n {
        return (Vec::new(), 0);
    }

    // Bitmap dedup: an edge can appear in both directions, and a row may
    // contain duplicates if the source file did.
    let mut seen = vec![0u64; n.div_ceil(64)];
    let mut mark = |v: u32| -> bool {
        if v == node {
            return false;
        }
        let (word, bit) = (v as usize / 64, 1u64 << (v as usize % 64));
        if seen[word] & bit != 0 {
            return false;
        }
        seen[word] |= bit;
        true
    };

    let mut total = 0usize;
    for e in offsets[node as usize]..offsets[node as usize + 1] {
        if mark(targets[e as usize]) {
            total += 1;
        }
    }
    for src in 0..n {
        for e in offsets[src]..offsets[src + 1] {
            if targets[e as usize] == node && mark(src as u32) {
                total += 1;
            }
        }
    }

    // Ascending order makes the sidebar list stable across runs (D2) and is
    // free: walk the bitmap rather than sorting the hits.
    let mut out = Vec::with_capacity(total.min(cap));
    'outer: for (word_at, &word) in seen.iter().enumerate() {
        let mut bits = word;
        while bits != 0 {
            if out.len() == cap {
                break 'outer;
            }
            let bit = bits.trailing_zeros() as usize;
            out.push((word_at * 64 + bit) as u32);
            bits &= bits - 1;
        }
    }
    (out, total)
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
