//! Resolution of request paths to bytes, from either the baked-in bundle or a
//! directory on disk (`--web-root`, for developing against the CLI without
//! rebuilding it).

use std::borrow::Cow;
use std::fs;
use std::path::{Component, Path, PathBuf};

include!(concat!(env!("OUT_DIR"), "/embedded.rs"));

pub enum Assets {
    Embedded,
    Dir(PathBuf),
}

impl Assets {
    pub fn is_empty(&self) -> bool {
        matches!(self, Assets::Embedded) && EMBEDDED.is_empty()
    }

    pub fn describe(&self) -> String {
        match self {
            Assets::Embedded => format!("embedded ({} files)", EMBEDDED.len()),
            Assets::Dir(dir) => dir.display().to_string(),
        }
    }

    /// `route` must already be normalized by [`normalize`] — the content type
    /// and cache headers are derived from the same normalized string, so
    /// resolving it here instead would let `/` be served as `index.html` while
    /// still being labelled `application/octet-stream`.
    pub fn get(&self, route: &str) -> Option<Cow<'static, [u8]>> {
        match self {
            Assets::Embedded => EMBEDDED
                .iter()
                .find(|(name, _)| *name == route)
                .map(|(_, bytes)| Cow::Borrowed(*bytes)),
            Assets::Dir(dir) => {
                let path = safe_join(dir, route)?;
                fs::read(path).ok().map(Cow::Owned)
            }
        }
    }
}

/// Maps a directory-ish request path to the file that actually answers it.
/// This is the only rewrite the server performs — there is no SPA catch-all,
/// so a missing file stays a real 404.
pub fn normalize(route: &str) -> String {
    if route.is_empty() || route.ends_with('/') {
        format!("{route}index.html")
    } else {
        route.to_string()
    }
}

/// Joins `rel` onto `root`, refusing anything that could escape it. Rejects
/// absolute paths, `..`, and (on Windows) drive prefixes before touching the
/// filesystem, then confirms the canonical result is still inside `root` so a
/// symlink inside the web root cannot be used to read the rest of the disk.
pub fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = Path::new(rel);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    let joined = root.join(rel);
    let canonical = joined.canonicalize().ok()?;
    let root = root.canonicalize().ok()?;
    canonical.starts_with(root).then_some(canonical)
}

/// Content types the app actually depends on. `.wasm` must be
/// `application/wasm` or `WebAssembly.instantiateStreaming` refuses the module,
/// and the workers must be served as JavaScript.
pub fn content_type(route: &str) -> &'static str {
    let ext = Path::new(route)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "wasm" => "application/wasm",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "txt" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Vite emits content-hashed filenames under `assets/`, so those are immutable;
/// everything else (entry HTML above all) must be revalidated or a stale index
/// will keep pointing at bundles that no longer exist.
pub fn cache_control(route: &str) -> &'static str {
    if route.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

/// Minimal percent-decoding. Returns `None` on malformed escapes or on an
/// embedded NUL, both of which only show up in path-traversal attempts.
pub fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hex = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    if out.contains(&0) {
        return None;
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("a%20b").as_deref(), Some("a b"));
        assert_eq!(percent_decode("plain").as_deref(), Some("plain"));
        // Truncated and non-hex escapes are rejected rather than passed through.
        assert_eq!(percent_decode("%2"), None);
        assert_eq!(percent_decode("%zz"), None);
        assert_eq!(percent_decode("a%00b"), None);
    }

    #[test]
    fn rejects_traversal_before_hitting_disk() {
        let root = Path::new("/tmp/skein-does-not-exist");
        assert!(safe_join(root, "../etc/passwd").is_none());
        assert!(safe_join(root, "/etc/passwd").is_none());
        // The encoded form decodes to the same components, so it is caught too.
        let decoded = percent_decode("..%2fetc%2fpasswd").unwrap();
        assert!(safe_join(root, &decoded).is_none());
    }

    #[test]
    fn serves_index_for_directory_routes() {
        let dir = std::env::temp_dir().join("skein-assets-test");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("index.html"), b"root").unwrap();
        fs::write(dir.join("sub/index.html"), b"nested").unwrap();
        let assets = Assets::Dir(dir.clone());
        assert_eq!(assets.get(&normalize("")).as_deref(), Some(&b"root"[..]));
        assert_eq!(
            assets.get(&normalize("sub/")).as_deref(),
            Some(&b"nested"[..])
        );
        assert!(assets.get(&normalize("missing.html")).is_none());
        fs::remove_dir_all(dir).ok();
    }

    /// Regression: `/` used to resolve to index.html for the body but keep the
    /// unnormalized route for the headers, so the app root was served as
    /// `application/octet-stream`. Combined with `nosniff`, browsers downloaded
    /// the page instead of rendering it.
    #[test]
    fn directory_routes_are_typed_as_html() {
        assert_eq!(content_type(&normalize("")), "text/html; charset=utf-8");
        assert_eq!(content_type(&normalize("sub/")), "text/html; charset=utf-8");
    }

    #[test]
    fn wasm_and_workers_get_types_the_browser_requires() {
        assert_eq!(content_type("pkg/skein_wasm_bg.wasm"), "application/wasm");
        assert_eq!(
            content_type("assets/ingest-abc123.js"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type("noext"), "application/octet-stream");
    }

    #[test]
    fn only_hashed_assets_are_cached_forever() {
        assert!(cache_control("assets/index-abc123.js").contains("immutable"));
        assert_eq!(cache_control("index.html"), "no-cache");
    }
}
