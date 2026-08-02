//! Compressed sparse row adjacency, built with a two-pass counting sort
//! (REQUIREMENTS.md §4.1): degree histogram, prefix sum, fill.

pub struct Csr {
    /// offsets[i]..offsets[i+1] delimits node i's out-edges in `targets`.
    pub offsets: Vec<u32>,
    pub targets: Vec<u32>,
    /// Parallel to `targets` when the input had weights.
    pub weights: Option<Vec<f32>>,
}

/// A borrowed CSR: the same struct-of-arrays as [`Csr`], but pointing at
/// memory this type does not own.
///
/// Exists so an adjacency that lives in a memory-mapped file can be fed to the
/// algorithms without first being copied into `Vec`s. At the 100M-edge tier
/// that copy is the difference between one resident working set and two
/// (DECISIONS.md D15). Every function here that only reads a CSR takes this;
/// the owning [`Csr`] converts with [`Csr::as_view`] for free.
#[derive(Clone, Copy)]
pub struct CsrView<'a> {
    pub offsets: &'a [u32],
    pub targets: &'a [u32],
    /// Parallel to `targets` when the source had weights.
    pub weights: Option<&'a [f32]>,
}

impl CsrView<'_> {
    #[inline]
    pub fn node_count(&self) -> u32 {
        (self.offsets.len() - 1) as u32
    }

    #[inline]
    pub fn edge_count(&self) -> usize {
        self.targets.len()
    }
}

impl Csr {
    /// Borrow this CSR without copying.
    #[inline]
    pub fn as_view(&self) -> CsrView<'_> {
        CsrView {
            offsets: &self.offsets,
            targets: &self.targets,
            weights: self.weights.as_deref(),
        }
    }

    /// Build from an unsorted edge list. `n` is the node count; every id in
    /// `sources`/`targets` must be < n. Panics if `sources` and `targets`
    /// (and `weights`, when given) differ in length.
    ///
    /// Edge order within a row preserves input order (the fill pass is a
    /// stable counting sort), so the result is deterministic for a given
    /// input ordering.
    pub fn from_edges(n: u32, sources: &[u32], targets: &[u32], weights: Option<&[f32]>) -> Csr {
        assert_eq!(sources.len(), targets.len());
        if let Some(w) = weights {
            assert_eq!(w.len(), sources.len());
        }
        let m = sources.len();

        // Pass 1: degree histogram, shifted by one so the prefix sum lands
        // directly in offset position.
        let mut offsets = vec![0u32; n as usize + 2];
        for &s in sources {
            offsets[s as usize + 2] += 1;
        }
        for i in 2..offsets.len() {
            offsets[i] += offsets[i - 1];
        }

        // Pass 2: fill, using offsets[i+1] as node i's write cursor.
        let mut out_targets = vec![0u32; m];
        let mut out_weights = weights.map(|_| vec![0f32; m]);
        for e in 0..m {
            let cursor = &mut offsets[sources[e] as usize + 1];
            let at = *cursor as usize;
            out_targets[at] = targets[e];
            if let (Some(out_w), Some(w)) = (out_weights.as_mut(), weights) {
                out_w[at] = w[e];
            }
            *cursor += 1;
        }

        offsets.pop();
        Csr {
            offsets,
            targets: out_targets,
            weights: out_weights,
        }
    }

    #[inline]
    pub fn node_count(&self) -> u32 {
        (self.offsets.len() - 1) as u32
    }

    #[inline]
    pub fn edge_count(&self) -> usize {
        self.targets.len()
    }

    #[inline]
    pub fn neighbors(&self, node: u32) -> &[u32] {
        let start = self.offsets[node as usize] as usize;
        let end = self.offsets[node as usize + 1] as usize;
        &self.targets[start..end]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_small_graph() {
        // 0→1, 0→2, 2→0, 1→2, node 3 isolated
        let csr = Csr::from_edges(4, &[0, 0, 2, 1], &[1, 2, 0, 2], None);
        assert_eq!(csr.node_count(), 4);
        assert_eq!(csr.edge_count(), 4);
        assert_eq!(csr.offsets, vec![0, 2, 3, 4, 4]);
        assert_eq!(csr.neighbors(0), &[1, 2]);
        assert_eq!(csr.neighbors(1), &[2]);
        assert_eq!(csr.neighbors(2), &[0]);
        assert_eq!(csr.neighbors(3), &[] as &[u32]);
    }

    #[test]
    fn preserves_input_order_within_row() {
        let csr = Csr::from_edges(2, &[0, 0, 0], &[1, 0, 1], None);
        assert_eq!(csr.neighbors(0), &[1, 0, 1]);
    }

    #[test]
    fn carries_weights() {
        let csr = Csr::from_edges(3, &[1, 0, 1], &[0, 1, 2], Some(&[0.5, 1.5, 2.5]));
        assert_eq!(csr.neighbors(1), &[0, 2]);
        assert_eq!(csr.weights.as_deref(), Some(&[1.5, 0.5, 2.5][..]));
    }

    #[test]
    fn empty_graph() {
        let csr = Csr::from_edges(0, &[], &[], None);
        assert_eq!(csr.node_count(), 0);
        assert_eq!(csr.edge_count(), 0);
        assert_eq!(csr.offsets, vec![0]);
    }

    #[test]
    fn deterministic() {
        let sources: Vec<u32> = (0..1000).map(|i| (i * 7) % 100).collect();
        let targets: Vec<u32> = (0..1000).map(|i| (i * 13) % 100).collect();
        let a = Csr::from_edges(100, &sources, &targets, None);
        let b = Csr::from_edges(100, &sources, &targets, None);
        assert_eq!(a.offsets, b.offsets);
        assert_eq!(a.targets, b.targets);
    }
}
