//! wasm-bindgen boundary. Keep this crate a thin translation layer: all
//! algorithms live in skein-core, which stays testable natively.
//!
//! Build: wasm-pack build crates/skein-wasm --target web --out-dir ../../web/src/wasm-pkg

use wasm_bindgen::prelude::*;

/// Ingest session: intern edge endpoints as they stream in, then build CSR.
///
/// The caller (ingest worker) feeds batches of newline-split id pairs; we
/// return nothing per-batch to keep the boundary chatter-free, and hand back
/// flat typed arrays at the end (REQUIREMENTS.md §4.2).
#[wasm_bindgen]
pub struct IngestSession {
    interner: skein_core::Interner,
    sources: Vec<u32>,
    targets: Vec<u32>,
}

#[wasm_bindgen]
impl IngestSession {
    #[wasm_bindgen(constructor)]
    pub fn new(expected_nodes: u32) -> IngestSession {
        IngestSession {
            interner: skein_core::Interner::with_capacity(expected_nodes as usize),
            sources: Vec::new(),
            targets: Vec::new(),
        }
    }

    /// Add one edge by raw id bytes. Batch-oriented entry points that parse
    /// whole CSV chunks in WASM come with M1; this per-edge path exists so
    /// the boundary can be exercised end-to-end before the parser lands.
    pub fn add_edge(&mut self, source_id: &[u8], target_id: &[u8]) {
        let s = self.interner.intern(source_id);
        let t = self.interner.intern(target_id);
        self.sources.push(s);
        self.targets.push(t);
    }

    pub fn node_count(&self) -> u32 {
        self.interner.len() as u32
    }

    pub fn edge_count(&self) -> u32 {
        self.sources.len() as u32
    }

    /// Build CSR and return [offsets, targets] as transferable buffers.
    pub fn finish(self) -> js_sys::Array {
        let csr = skein_core::Csr::from_edges(
            self.interner.len() as u32,
            &self.sources,
            &self.targets,
            None,
        );
        let out = js_sys::Array::new();
        out.push(&js_sys::Uint32Array::from(&csr.offsets[..]));
        out.push(&js_sys::Uint32Array::from(&csr.targets[..]));
        out
    }
}
