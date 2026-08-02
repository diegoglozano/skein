//! Where the hierarchy build puts the arrays that scale with *edge* count.
//!
//! The rest of the pipeline is already out-of-core: `skein-native`'s store mmaps
//! the ingested CSR, and every algorithm reads it borrowed (D15/N2). The
//! hierarchy build was the exception — `symmetrize` and `coarsen_once` allocate
//! their output on the heap, and at the 100M-edge tier that output is ~1.6 GB
//! that stays resident for the whole run. Measured, it is where peak RSS
//! actually is (DECISIONS.md D15, N2 follow-up 2).
//!
//! This module makes that storage a *policy*. [`HeapScratch`] is the default and
//! the only thing wasm can use (§8: one 4 GB linear memory, no files).
//! [`MmapScratch`] puts the same arrays in a memory-mapped scratch file, so the
//! pages are file-backed: the kernel can write them back and evict them under
//! pressure, where an anonymous allocation of the same size can only go to swap
//! or fail. That difference is the whole of "larger than RAM".
//!
//! **Do not put the scratch on tmpfs.** `/tmp` is tmpfs on most Linux installs,
//! and tmpfs pages are backed by *swap*, not by a disk. A scratch file there is
//! page cache that can only be evicted to swap — on a swapless machine, not at
//! all — so the whole mechanism silently reduces to the heap while looking like
//! it worked. Callers pass a directory for this reason rather than getting a
//! temp dir by default, and both front ends default to the directory the graph
//! itself came from.
//!
//! **Why this works at all** is a property of the access patterns, not of mmap:
//! every pass over an edge-sized array in the hierarchy build and the force sim
//! walks it in CSR row order, i.e. sequentially. The arrays that are touched
//! *randomly* — labels, vote scratch, positions — are all node-sized. So the
//! resident working set is O(nodes) while the streamed set is O(edges), which is
//! what lets a graph whose edges do not fit in RAM still lay out.

use std::io;

/// A large, fixed-capacity region of 4-byte elements, viewable as `u32` or
/// `f32`. Both views alias the same bytes; the hierarchy build uses one slab for
/// targets and one for weights and never mixes the two on a single slab.
///
/// `Send` because `skein-native` moves a finished hierarchy onto its layout
/// thread.
pub trait Slab: Send {
    fn u32s(&self) -> &[u32];
    fn u32s_mut(&mut self) -> &mut [u32];
    fn f32s(&self) -> &[f32];
    fn f32s_mut(&mut self) -> &mut [f32];

    /// Shrink the *logical* length after the build discovers how much of the
    /// upper-bound allocation it actually used. Implementations may or may not
    /// release the tail; they must not move or alter the retained prefix.
    fn shrink_to(&mut self, len: usize);
}

/// Allocator for [`Slab`]s, plus the locality policy that goes with the storage.
pub trait Scratch: Send + Sync {
    /// A zeroed slab of exactly `len` 4-byte elements.
    fn alloc(&self, len: usize) -> io::Result<Box<dyn Slab>>;

    /// How many triples the build may stage before it must sort and compact
    /// them. This bounds the *dirty* window over a slab: the build processes
    /// rows in bands of roughly this size, so a file-backed slab is written in
    /// one bounded region at a time instead of scattered across its whole
    /// extent. [`usize::MAX`] means one band, which is what the heap wants —
    /// banding buys it nothing and costs an extra pass over the input.
    fn band_len(&self) -> usize {
        usize::MAX
    }

    /// Short name for logs and HUDs, so a run says which tier it was on.
    fn label(&self) -> &'static str;
}

/// The heap. Default everywhere, and the only option under wasm.
pub struct HeapScratch;

impl Scratch for HeapScratch {
    fn alloc(&self, len: usize) -> io::Result<Box<dyn Slab>> {
        Ok(Box::new(HeapSlab {
            words: vec![0u32; len],
            len,
        }))
    }

    fn label(&self) -> &'static str {
        "heap"
    }
}

struct HeapSlab {
    words: Vec<u32>,
    len: usize,
}

impl Slab for HeapSlab {
    fn u32s(&self) -> &[u32] {
        &self.words[..self.len]
    }
    fn u32s_mut(&mut self) -> &mut [u32] {
        &mut self.words[..self.len]
    }
    fn f32s(&self) -> &[f32] {
        bytemuck::cast_slice(self.u32s())
    }
    fn f32s_mut(&mut self) -> &mut [f32] {
        bytemuck::cast_slice_mut(self.u32s_mut())
    }

    /// Copy down to an exact allocation only when at least half the slab is
    /// slack — which is the `coarsen_once` case, where the output is an order of
    /// magnitude smaller than its upper bound. Otherwise keep the capacity:
    /// `shrink_to_fit` on a nearly-full multi-gigabyte `Vec` can reallocate and
    /// copy, and a transient second copy is exactly what this module exists to
    /// avoid. (The pre-D16 code never shrank at all, so keeping is no
    /// regression.)
    fn shrink_to(&mut self, len: usize) {
        debug_assert!(len <= self.len);
        self.len = len;
        if len * 2 < self.words.len() {
            self.words = self.words[..len].to_vec();
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub use mapped::MmapScratch;

#[cfg(not(target_arch = "wasm32"))]
mod mapped {
    use super::{Scratch, Slab};
    use std::fs::OpenOptions;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Slabs backed by a memory-mapped scratch file per allocation.
    ///
    /// The file is created sparse (`set_len` on a fresh file), so the tail of an
    /// upper-bound allocation that the build never writes costs no disk either.
    /// On Unix it is unlinked the moment it is mapped: the mapping keeps it
    /// alive, and a crash cannot leave gigabytes of scratch behind. Elsewhere it
    /// is removed when the slab drops.
    pub struct MmapScratch {
        dir: PathBuf,
        band: usize,
        min_mapped: usize,
    }

    /// Process-global, so two scratches in one process cannot pick the same
    /// name. A per-instance counter looked fine until two tests ran at once.
    static NEXT_ID: AtomicU64 = AtomicU64::new(0);

    /// Below this many elements a slab is not worth a file: the coarse levels of
    /// a hierarchy shrink by ~10x each, so most of them are megabytes at most
    /// and are read randomly enough that residency is what you want.
    const DEFAULT_MIN_MAPPED: usize = 1 << 20; // 4 MB

    impl MmapScratch {
        /// `dir` must exist and have room for roughly 8 bytes per symmetrized
        /// edge. `band_bytes` bounds the dirty window (see
        /// [`Scratch::band_len`]).
        pub fn new(dir: impl AsRef<Path>, band_bytes: usize) -> MmapScratch {
            MmapScratch {
                dir: dir.as_ref().to_path_buf(),
                // Two slabs (targets and weights) are written in lockstep, so a
                // band of k triples dirties 2 * 4 * k bytes.
                band: (band_bytes / 8).max(1 << 16),
                min_mapped: DEFAULT_MIN_MAPPED,
            }
        }

        /// Map even small slabs. For tests, which would otherwise exercise the
        /// heap fallback and prove nothing about the mapped path.
        pub fn min_mapped(mut self, elements: usize) -> MmapScratch {
            self.min_mapped = elements;
            self
        }
    }

    impl Scratch for MmapScratch {
        fn alloc(&self, len: usize) -> io::Result<Box<dyn Slab>> {
            if len < self.min_mapped {
                return super::HeapScratch.alloc(len);
            }
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let path = self
                .dir
                .join(format!("skein-scratch-{}-{id}.tmp", std::process::id()));
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(&path)?;
            // A zero-length mapping is invalid; keep one page so the slab is
            // still a valid (empty) slice.
            file.set_len((len as u64 * 4).max(4096))?;
            // SAFETY: the usual mmap caveat. This file is created by this
            // process with a unique name, is unlinked immediately below on Unix,
            // and is never opened by anything else.
            let map = unsafe { memmap2::MmapMut::map_mut(&file)? };

            // Unlink now where the platform allows it: the mapping keeps the
            // inode alive, and a crash then cannot strand gigabytes of scratch.
            // Where it does not, the slab deletes on drop instead.
            let unlink_on_drop = if cfg!(unix) {
                std::fs::remove_file(&path)?;
                None
            } else {
                Some(path)
            };
            Ok(Box::new(MmapSlab {
                map,
                len,
                unlink_on_drop,
            }))
        }

        fn band_len(&self) -> usize {
            self.band
        }

        fn label(&self) -> &'static str {
            "mmap"
        }
    }

    struct MmapSlab {
        map: memmap2::MmapMut,
        len: usize,
        /// Some only where the file could not be unlinked while still mapped.
        unlink_on_drop: Option<PathBuf>,
    }

    impl Drop for MmapSlab {
        fn drop(&mut self) {
            if let Some(path) = &self.unlink_on_drop {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    impl Slab for MmapSlab {
        fn u32s(&self) -> &[u32] {
            &bytemuck::cast_slice(&self.map[..self.len * 4])[..self.len]
        }
        fn u32s_mut(&mut self) -> &mut [u32] {
            let len = self.len;
            &mut bytemuck::cast_slice_mut(&mut self.map[..len * 4])[..len]
        }
        fn f32s(&self) -> &[f32] {
            bytemuck::cast_slice(self.u32s())
        }
        fn f32s_mut(&mut self) -> &mut [f32] {
            bytemuck::cast_slice_mut(self.u32s_mut())
        }

        /// Nothing to copy: the tail was never written, so on a sparse file it
        /// was never allocated and never resident. Only the logical length moves.
        fn shrink_to(&mut self, len: usize) {
            debug_assert!(len <= self.len);
            self.len = len;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exercise(scratch: &dyn Scratch) {
        let mut slab = scratch.alloc(16).unwrap();
        assert_eq!(slab.u32s().len(), 16);
        assert!(
            slab.u32s().iter().all(|&w| w == 0),
            "{}: a fresh slab must be zeroed",
            scratch.label()
        );

        slab.u32s_mut()[3] = 0xdead_beef;
        assert_eq!(slab.u32s()[3], 0xdead_beef);

        // The f32 view aliases the same bytes, which is what lets one slab hold
        // targets and another hold weights without a second allocator.
        slab.f32s_mut()[5] = -2.5;
        assert_eq!(slab.f32s()[5], -2.5);
        assert_eq!(slab.u32s()[5], (-2.5f32).to_bits());

        slab.shrink_to(6);
        assert_eq!(slab.u32s().len(), 6);
        assert_eq!(slab.u32s()[3], 0xdead_beef, "shrink must retain the prefix");
        assert_eq!(slab.f32s()[5], -2.5);
    }

    #[test]
    fn heap_slabs_behave() {
        exercise(&HeapScratch);
    }

    #[test]
    fn heap_shrink_releases_a_mostly_empty_slab() {
        let mut slab = HeapScratch.alloc(1000).unwrap();
        slab.u32s_mut()[0] = 7;
        slab.shrink_to(10);
        assert_eq!(slab.u32s(), &[7, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn mmap_slabs_behave() {
        let scratch = MmapScratch::new(std::env::temp_dir(), 1 << 20).min_mapped(0);
        exercise(&scratch);
        assert!(scratch.band_len() < usize::MAX, "mmap must band");
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn mmap_slabs_hold_more_than_one_allocation() {
        // Two live slabs at once is the normal case (targets and weights), so a
        // name collision or a premature unlink would show up here.
        let scratch = MmapScratch::new(std::env::temp_dir(), 1 << 20).min_mapped(0);
        let mut a = scratch.alloc(1024).unwrap();
        let mut b = scratch.alloc(1024).unwrap();
        a.u32s_mut()[0] = 1;
        b.u32s_mut()[0] = 2;
        assert_eq!((a.u32s()[0], b.u32s()[0]), (1, 2));
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn mmap_alloc_of_zero_is_valid_and_empty() {
        let scratch = MmapScratch::new(std::env::temp_dir(), 1 << 20).min_mapped(0);
        let slab = scratch.alloc(0).unwrap();
        assert!(slab.u32s().is_empty());
    }
}
