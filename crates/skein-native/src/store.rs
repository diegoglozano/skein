//! On-disk CSR store, memory-mapped on open (D15/N2).
//!
//! The file layout *is* the in-memory layout: a fixed header followed by the
//! flat `u32`/`f32` arrays back to back. Opening therefore costs an `mmap` and
//! two slice casts — no parse, no allocation proportional to the graph, and the
//! OS pages in only what the algorithms actually touch. That is what lets a
//! file larger than RAM be laid out at all, which is the capacity argument D15
//! rests on.
//!
//! Byte order is native and the format carries a version: this is a local cache
//! beside the source CSV, not an interchange format. A mismatch is an error, so
//! a stale or foreign file can never be silently misread as graph data.
//!
//! Alignment: the header is 64 bytes and every section is a multiple of 4, so
//! against a page-aligned mmap base every `u32`/`f32` array is 4-byte aligned.
//! The casts still go through `try_cast_slice` rather than assuming it.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use memmap2::Mmap;
use skein_core::{Csr, CsrView};

const MAGIC: &[u8; 8] = b"SKEINCSR";
const VERSION: u32 = 1;
const HEADER_BYTES: usize = 64;
const FLAG_WEIGHTS: u32 = 1;

/// `<source>.skein` beside the input file.
pub fn store_path(source: &Path) -> PathBuf {
    let mut name = source.as_os_str().to_os_string();
    name.push(".skein");
    PathBuf::from(name)
}

/// True when `store` exists and is at least as new as `source`. A store older
/// than its CSV is stale by definition and gets rebuilt rather than trusted.
pub fn is_fresh(store: &Path, source: &Path) -> bool {
    let (Ok(s), Ok(src)) = (std::fs::metadata(store), std::fs::metadata(source)) else {
        return false;
    };
    match (s.modified(), src.modified()) {
        (Ok(a), Ok(b)) => a >= b,
        _ => false,
    }
}

fn put_u32(w: &mut impl Write, v: u32) -> std::io::Result<()> {
    w.write_all(&v.to_ne_bytes())
}
fn put_u64(w: &mut impl Write, v: u64) -> std::io::Result<()> {
    w.write_all(&v.to_ne_bytes())
}

/// Write a CSR plus its id dictionary. Streams through a `BufWriter`, so peak
/// memory is the buffer rather than a serialized copy of the graph.
pub fn write(path: &Path, csr: &Csr, id_bytes: &[u8], id_offsets: &[u32]) -> std::io::Result<()> {
    let file = File::create(path)?;
    let mut w = BufWriter::with_capacity(1 << 20, file);

    let has_weights = csr.weights.is_some();
    w.write_all(MAGIC)?;
    put_u32(&mut w, VERSION)?;
    put_u32(&mut w, if has_weights { FLAG_WEIGHTS } else { 0 })?;
    put_u32(&mut w, csr.node_count())?;
    put_u32(&mut w, 0)?; // pad
    put_u64(&mut w, csr.edge_count() as u64)?;
    put_u64(&mut w, id_bytes.len() as u64)?;
    w.write_all(&[0u8; HEADER_BYTES - 40])?;

    w.write_all(bytemuck::cast_slice(&csr.offsets))?;
    w.write_all(bytemuck::cast_slice(&csr.targets))?;
    if let Some(weights) = &csr.weights {
        w.write_all(bytemuck::cast_slice(weights))?;
    }
    w.write_all(bytemuck::cast_slice(id_offsets))?;
    w.write_all(id_bytes)?;
    w.flush()?;
    Ok(())
}

/// A memory-mapped store. The slice accessors borrow from the mapping, so
/// nothing is copied until an algorithm chooses to.
pub struct Store {
    map: Mmap,
    node_count: u32,
    edge_count: usize,
    has_weights: bool,
    id_bytes_len: usize,
}

impl Store {
    pub fn open(path: &Path) -> anyhow::Result<Store> {
        let file = File::open(path)?;
        // SAFETY: the usual mmap caveat — another process truncating this file
        // while it is mapped would fault. It is a cache we write ourselves,
        // beside the source, and the process re-reads it read-only.
        let map = unsafe { Mmap::map(&file)? };
        if map.len() < HEADER_BYTES {
            anyhow::bail!("store too small to contain a header");
        }
        if &map[0..8] != MAGIC {
            anyhow::bail!("not a skein store (bad magic)");
        }
        let u32_at =
            |off: usize| u32::from_ne_bytes([map[off], map[off + 1], map[off + 2], map[off + 3]]);
        let u64_at = |off: usize| {
            let mut b = [0u8; 8];
            b.copy_from_slice(&map[off..off + 8]);
            u64::from_ne_bytes(b)
        };
        let version = u32_at(8);
        if version != VERSION {
            anyhow::bail!("store version {version}, expected {VERSION} — delete it to rebuild");
        }
        let flags = u32_at(12);
        let node_count = u32_at(16);
        let edge_count = u64_at(24) as usize;
        let id_bytes_len = u64_at(32) as usize;

        let store = Store {
            map,
            node_count,
            edge_count,
            has_weights: flags & FLAG_WEIGHTS != 0,
            id_bytes_len,
        };
        let expect = store.expected_len();
        if store.map.len() < expect {
            anyhow::bail!(
                "store truncated: {} bytes, expected {expect}",
                store.map.len()
            );
        }
        Ok(store)
    }

    fn offsets_at(&self) -> usize {
        HEADER_BYTES
    }
    fn targets_at(&self) -> usize {
        self.offsets_at() + 4 * (self.node_count as usize + 1)
    }
    fn weights_at(&self) -> usize {
        self.targets_at() + 4 * self.edge_count
    }
    fn id_offsets_at(&self) -> usize {
        self.weights_at()
            + if self.has_weights {
                4 * self.edge_count
            } else {
                0
            }
    }
    fn id_bytes_at(&self) -> usize {
        self.id_offsets_at() + 4 * (self.node_count as usize + 1)
    }
    fn expected_len(&self) -> usize {
        self.id_bytes_at() + self.id_bytes_len
    }

    fn u32s(&self, at: usize, len: usize) -> &[u32] {
        bytemuck::try_cast_slice(&self.map[at..at + 4 * len])
            .expect("store sections are 4-byte aligned against a page-aligned mapping")
    }

    pub fn node_count(&self) -> u32 {
        self.node_count
    }

    pub fn edge_count(&self) -> usize {
        self.edge_count
    }

    pub fn offsets(&self) -> &[u32] {
        self.u32s(self.offsets_at(), self.node_count as usize + 1)
    }

    pub fn targets(&self) -> &[u32] {
        self.u32s(self.targets_at(), self.edge_count)
    }

    pub fn weights(&self) -> Option<&[f32]> {
        if !self.has_weights {
            return None;
        }
        let at = self.weights_at();
        Some(
            bytemuck::try_cast_slice(&self.map[at..at + 4 * self.edge_count])
                .expect("store sections are 4-byte aligned"),
        )
    }

    /// Borrowed CSR over the mapping — what `build_hierarchy_view` consumes.
    pub fn csr(&self) -> CsrView<'_> {
        CsrView {
            offsets: self.offsets(),
            targets: self.targets(),
            weights: self.weights(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("skein-store-test-{name}.skein"))
    }

    #[test]
    fn round_trips_a_csr() {
        let csr = Csr::from_edges(4, &[0, 0, 2, 1], &[1, 2, 0, 2], None);
        let id_bytes = b"n0n1n2n3".to_vec();
        let id_offsets = vec![0u32, 2, 4, 6, 8];
        let path = temp("roundtrip");
        write(&path, &csr, &id_bytes, &id_offsets).unwrap();

        let store = Store::open(&path).unwrap();
        assert_eq!(store.node_count(), 4);
        assert_eq!(store.edge_count(), 4);
        assert_eq!(store.offsets(), csr.offsets.as_slice());
        assert_eq!(store.targets(), csr.targets.as_slice());
        assert!(store.weights().is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn round_trips_weights() {
        let csr = Csr::from_edges(3, &[1, 0, 1], &[0, 1, 2], Some(&[0.5, 1.5, 2.5]));
        let path = temp("weights");
        write(&path, &csr, b"abc", &[0, 1, 2, 3]).unwrap();
        let store = Store::open(&path).unwrap();
        assert_eq!(store.weights(), csr.weights.as_deref());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn view_matches_the_owned_csr() {
        let csr = Csr::from_edges(4, &[0, 0, 2, 1], &[1, 2, 0, 2], None);
        let path = temp("view");
        write(&path, &csr, b"", &[0, 0, 0, 0, 0]).unwrap();
        let store = Store::open(&path).unwrap();
        let view = store.csr();
        assert_eq!(view.node_count(), csr.node_count());
        assert_eq!(view.edge_count(), csr.edge_count());
        assert_eq!(view.offsets, csr.offsets.as_slice());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rejects_foreign_and_truncated_files() {
        let path = temp("bad");
        std::fs::write(&path, b"not a skein store at all, definitely not").unwrap();
        assert!(Store::open(&path).is_err());

        // Valid header, body cut off.
        let csr = Csr::from_edges(4, &[0, 1], &[1, 2], None);
        write(&path, &csr, b"", &[0, 0, 0, 0, 0]).unwrap();
        let full = std::fs::read(&path).unwrap();
        std::fs::write(&path, &full[..HEADER_BYTES + 8]).unwrap();
        let err = match Store::open(&path) {
            Ok(_) => panic!("truncated store opened successfully"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("truncated"), "{err}");
        let _ = std::fs::remove_file(&path);
    }
}
