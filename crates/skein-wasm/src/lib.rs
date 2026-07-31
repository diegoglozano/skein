//! wasm-bindgen boundary. Keep this crate a thin translation layer: all
//! algorithms live in skein-core, which stays testable natively.
//!
//! Build: wasm-pack build crates/skein-wasm --target web --out-dir ../../web/src/wasm-pkg

use skein_core::{EdgeIngest, IngestConfig};
use wasm_bindgen::prelude::*;

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
