//! wasm-bindgen boundary. Keep this crate a thin translation layer: all
//! algorithms live in skein-core, which stays testable natively.
//!
//! Build: wasm-pack build crates/skein-wasm --target web --out-dir ../../web/src/wasm-pkg

use skein_core::{EdgeIngest, IngestConfig, MultilevelLayout, SimParams};
use wasm_bindgen::prelude::*;

/// Build the multilevel layout hierarchy (§6) from a persisted directed CSR.
/// Returns an Array of per-level objects
/// `{ offsets, targets, weights, parentMap }` — level 0 is the symmetrized
/// input graph, `parentMap` maps each level's nodes into the next (absent on
/// the coarsest level). All buffers are freshly-allocated typed arrays, safe
/// to transfer.
#[wasm_bindgen]
pub fn build_layout_hierarchy(
    offsets: &[u32],
    targets: &[u32],
    target_nodes: u32,
    max_levels: u32,
) -> js_sys::Array {
    let csr = skein_core::Csr {
        offsets: offsets.to_vec(),
        targets: targets.to_vec(),
        weights: None,
    };
    let levels = skein_core::build_hierarchy(&csr, target_nodes, max_levels as usize);

    let out = js_sys::Array::new();
    for level in &levels {
        let obj = js_sys::Object::new();
        let set = |k: &str, v: &JsValue| {
            js_sys::Reflect::set(&obj, &JsValue::from_str(k), v).unwrap();
        };
        set(
            "offsets",
            &js_sys::Uint32Array::from(&level.graph.offsets[..]),
        );
        set(
            "targets",
            &js_sys::Uint32Array::from(&level.graph.targets[..]),
        );
        let weights = level.graph.weights.as_deref().unwrap_or(&[]);
        set("weights", &js_sys::Float32Array::from(weights));
        if !level.parent_map.is_empty() {
            set(
                "parentMap",
                &js_sys::Uint32Array::from(&level.parent_map[..]),
            );
        }
        out.push(&obj);
    }
    out
}

/// Multilevel force layout (§6) driven from JS, for the no-WebGPU tier: build
/// the hierarchy and run the CPU sim entirely in Rust, stepping in chunks so
/// the worker can post progress and stay responsive. The WebGPU tier runs the
/// WGSL engine on the main thread instead and never touches this.
#[wasm_bindgen]
pub struct LayoutSession {
    inner: MultilevelLayout,
}

#[wasm_bindgen]
impl LayoutSession {
    /// Coarsens the persisted directed CSR itself — the caller does not need
    /// the hierarchy on its side. `max_sim_nodes` bounds which levels get a
    /// force sim; larger levels are prolongation-only (§8).
    #[wasm_bindgen(constructor)]
    pub fn new(
        offsets: &[u32],
        targets: &[u32],
        seed: u32,
        target_nodes: u32,
        max_levels: u32,
        max_sim_nodes: u32,
    ) -> LayoutSession {
        let csr = skein_core::Csr {
            offsets: offsets.to_vec(),
            targets: targets.to_vec(),
            weights: None,
        };
        let levels = skein_core::build_hierarchy(&csr, target_nodes, max_levels as usize);
        LayoutSession {
            inner: MultilevelLayout::new(
                levels,
                seed,
                SimParams::default(),
                max_sim_nodes as usize,
            ),
        }
    }

    /// Advance at most `budget` force iterations. Returns true when finished.
    pub fn step(&mut self, budget: u32) -> bool {
        self.inner.step(budget)
    }

    /// `{ level, levels, iter, iters, nodes }` — level is 1-based from the
    /// coarsest, matching the GPU path's progress reporting.
    pub fn progress(&self) -> js_sys::Object {
        let p = self.inner.progress();
        let obj = js_sys::Object::new();
        let set = |k: &str, v: f64| {
            js_sys::Reflect::set(&obj, &JsValue::from_str(k), &JsValue::from_f64(v)).unwrap();
        };
        set("level", f64::from(p.level));
        set("levels", f64::from(p.levels));
        set("iter", f64::from(p.iter));
        set("iters", f64::from(p.iters));
        set("nodes", f64::from(p.nodes));
        obj
    }

    /// Positions at the level currently being refined, as a freshly-allocated
    /// (so transferable) Float32Array of xy pairs.
    pub fn positions(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.inner.positions())
    }
}

/// Ingest session: stream CSV chunks in, get flat typed arrays out
/// (REQUIREMENTS.md §4.1–4.2). The ingest worker feeds `File.stream()` chunks
/// via `push_chunk`; nothing is returned per-chunk to keep the boundary
/// chatter-free. `finish` builds the CSR and hands back every buffer at once.
#[wasm_bindgen]
pub struct IngestSession {
    inner: Option<EdgeIngest>,
}

#[wasm_bindgen]
impl IngestSession {
    /// `weight_col < 0` means the edge list has no weight column.
    #[wasm_bindgen(constructor)]
    pub fn new(
        expected_nodes: u32,
        has_header: bool,
        source_col: u32,
        target_col: u32,
        weight_col: i32,
        delimiter: u8,
    ) -> IngestSession {
        let config = IngestConfig {
            delimiter,
            has_header,
            source_col: source_col as usize,
            target_col: target_col as usize,
            weight_col: usize::try_from(weight_col).ok(),
        };
        IngestSession {
            inner: Some(EdgeIngest::new(config, expected_nodes as usize)),
        }
    }

    /// Feed one chunk of CSV bytes; chunk boundaries may fall anywhere,
    /// including inside a quoted field.
    pub fn push_chunk(&mut self, chunk: &[u8]) -> Result<(), JsError> {
        self.session()?.push_chunk(chunk);
        Ok(())
    }

    pub fn node_count(&self) -> u32 {
        self.inner.as_ref().map_or(0, |s| s.node_count() as u32)
    }

    pub fn edge_count(&self) -> u32 {
        self.inner.as_ref().map_or(0, |s| s.edge_count() as u32)
    }

    pub fn skipped_rows(&self) -> f64 {
        self.inner.as_ref().map_or(0.0, |s| s.skipped_rows() as f64)
    }

    /// Build CSR + dictionary and return them as one object:
    /// `{ offsets, targets, weights?, idBytes, idOffsets, header?, nodeCount,
    ///    edgeCount, skippedRows }`. Consumes the session; further calls fail.
    pub fn finish(&mut self) -> Result<js_sys::Object, JsError> {
        let out = self
            .inner
            .take()
            .ok_or_else(|| JsError::new("IngestSession already finished"))?
            .finish();

        let result = js_sys::Object::new();
        let set = |k: &str, v: &JsValue| {
            // Reflect::set only fails on frozen/proxy targets; not possible here.
            js_sys::Reflect::set(&result, &JsValue::from_str(k), v).unwrap();
        };
        set("offsets", &js_sys::Uint32Array::from(&out.csr.offsets[..]));
        set("targets", &js_sys::Uint32Array::from(&out.csr.targets[..]));
        if let Some(w) = &out.csr.weights {
            set("weights", &js_sys::Float32Array::from(&w[..]));
        }
        set("idBytes", &js_sys::Uint8Array::from(&out.id_bytes[..]));
        set("idOffsets", &js_sys::Uint32Array::from(&out.id_offsets[..]));
        if let Some(header) = &out.header {
            let arr = js_sys::Array::new();
            for h in header {
                arr.push(&JsValue::from_str(h));
            }
            set("header", &arr);
        }
        set("nodeCount", &JsValue::from_f64(out.csr.node_count() as f64));
        set("edgeCount", &JsValue::from_f64(out.csr.edge_count() as f64));
        set("skippedRows", &JsValue::from_f64(out.skipped as f64));
        Ok(result)
    }

    fn session(&mut self) -> Result<&mut EdgeIngest, JsError> {
        self.inner
            .as_mut()
            .ok_or_else(|| JsError::new("IngestSession already finished"))
    }
}
