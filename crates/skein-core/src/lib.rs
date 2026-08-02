//! Core graph data structures for skein.
//!
//! Everything here is struct-of-arrays over flat buffers so it crosses the
//! WASM boundary without copying per-element (REQUIREMENTS.md §4.2). No
//! per-node or per-edge heap objects.

mod coarsen;
mod csr;
mod csv;
mod explore;
mod ingest;
mod interner;
mod layout;

pub use coarsen::{
    build_hierarchy, build_hierarchy_view, coarsen_once, symmetrize, symmetrize_view,
    HierarchyLevel,
};
pub use csr::{Csr, CsrView};
pub use csv::CsvScanner;
pub use explore::{neighbors, total_degrees};
pub use ingest::{EdgeIngest, IngestConfig, IngestOutput};
pub use interner::Interner;
pub use layout::{
    prolongate_positions, seed_disc_positions, LayoutProgress, LevelGraph, LevelSchedule, LevelSim,
    Mulberry32, MultilevelLayout, SimParams, COARSEST_ITERS, GRID, GRID2, MIN_ITERS, WORLD_SIZE,
};
