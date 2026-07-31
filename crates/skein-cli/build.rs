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
// directory-embedding crate keeps the dependency tree to one crate, which
// matters for a binary whose whole job is "be a single file".

use std::fs;
use std::path::{Path, PathBuf};

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

    let mut out = String::from("pub static EMBEDDED: &[(&str, &[u8])] = &[\n");
    for (route, file) in &assets {
        println!("cargo:rerun-if-changed={}", file.display());
        out.push_str(&format!(
            "    ({:?}, include_bytes!({:?})),\n",
            route,
            file.display().to_string()
        ));
    }
    out.push_str("];\n");

    let dest = PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("embedded.rs");
    fs::write(&dest, out).expect("write embedded.rs");
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
