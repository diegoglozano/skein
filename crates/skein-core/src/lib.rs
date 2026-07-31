//! Core graph data structures for skein.
//!
//! Everything here is struct-of-arrays over flat buffers so it crosses the
//! WASM boundary without copying per-element (REQUIREMENTS.md §4.2). No
//! per-node or per-edge heap objects.

mod csr;
mod interner;

pub use csr::Csr;
pub use interner::Interner;
