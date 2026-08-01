// Bakes `web/dist` into the binary as a table of (request path, bytes).
//
// The bundle is produced by `npm run build`, which is not part of the cargo
// build — so it is frequently absent (a bare `cargo test --workspace` or the
// clippy job in CI). That is not an error: we emit an empty table and the
// binary reports it has no embedded app and asks for `--web-root`. Release
// builds get the real thing because dist runs the web build first (see
// dist-workspace.toml).
//
// Generating a source file with `include_bytes!` rather than pulling in a
// directory-embedding crate keeps the runtime dependency tree small, which
// matters for a binary whose whole job is "be a single file".
//
// Assets above `COMPRESS_MIN` are brotli-compressed here and shipped
// compressed. That is not a micro-optimisation: M4's DuckDB bundle is a 34 MB
// wasm (DECISIONS.md D14), and embedding it raw took the binary from ~12 MB to
// ~48 MB. Compressed it is ~5 MB, and browsers ask for `br` anyway, so the
// bytes are usually served exactly as stored. Quality 9 rather than 11 —
// 2 seconds and 5.3 MB, against a minute and 5.1 MB.

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

/// Below this, compression costs a header and saves nothing worth having.
const COMPRESS_MIN: usize = 4096;
const BROTLI_QUALITY: i32 = 9;
const BROTLI_WINDOW: i32 = 22;

fn main() {
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let dist = match std::env::var_os("SKEIN_WEB_DIST") {
        Some(dir) => PathBuf::from(dir),
        // crates/skein-cli -> repo root
        None => manifest.join("../../web/dist"),
    };

    println!("cargo:rerun-if-env-changed=SKEIN_WEB_DIST");
    println!("cargo:rerun-if-changed={}", dist.display());

    let mut assets = Vec::new();
    if dist.is_dir() {
        collect(&dist, &dist, &mut assets);
        assets.sort();
    } else {
        println!(
            "cargo:warning=skein-cli: {} not found — building without an embedded web app. \
             Run `npm run build` first, or pass --web-root at runtime.",
            dist.display()
        );
    }

    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let compressed_dir = out_dir.join("br");
    fs::create_dir_all(&compressed_dir).expect("create brotli output dir");

    // Rows are (route, bytes, stored-as-brotli).
    let mut out = String::from("pub static EMBEDDED: &[(&str, &[u8], bool)] = &[\n");
    for (route, file) in &assets {
        println!("cargo:rerun-if-changed={}", file.display());
        let bytes = fs::read(file).expect("read asset");
        let (path, brotli) = if bytes.len() >= COMPRESS_MIN {
            let dest = compressed_dir.join(format!("{}.br", route.replace(['/', '\\'], "_")));
            fs::write(&dest, compress(&bytes)).expect("write compressed asset");
            (dest, true)
        } else {
            (file.clone(), false)
        };
        out.push_str(&format!(
            "    ({:?}, include_bytes!({:?}), {}),\n",
            route,
            path.display().to_string(),
            brotli
        ));
    }
    out.push_str("];\n");

    fs::write(out_dir.join("embedded.rs"), out).expect("write embedded.rs");
}

fn compress(data: &[u8]) -> Vec<u8> {
    let params = brotli::enc::BrotliEncoderParams {
        quality: BROTLI_QUALITY,
        lgwin: BROTLI_WINDOW,
        ..Default::default()
    };
    let mut out = Vec::new();
    brotli::BrotliCompress(&mut Cursor::new(data), &mut out, &params).expect("brotli compress");
    out
}

/// Walks `dir`, pushing (route, absolute path) pairs. Routes are `/`-joined and
/// relative to `root`, matching what the browser will ask for.
fn collect(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            println!(
                "cargo:warning=skein-cli: cannot read {}: {err}",
                dir.display()
            );
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(root, &path, out);
        } else if let Ok(rel) = path.strip_prefix(root) {
            let route = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            out.push((route, path));
        }
    }
}
