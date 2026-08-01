//! A static file server with exactly the headers the app needs.
//!
//! This is not a general-purpose web server and should not grow into one. It
//! exists because skein cannot be served by `python -m http.server`: the app
//! needs COOP/COEP for SharedArrayBuffer (REQUIREMENTS.md §8) and carries a
//! strict CSP (§7, D1), and getting those wrong degrades the app silently
//! rather than loudly.

use std::fs::File;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::Arc;

use tiny_http::{Header, Request, Response, ResponseBox, Server, StatusCode};

use crate::assets::{cache_control, content_type, normalize, percent_decode, Assets};

/// Mirrors `web/public/_headers` and the build-time meta tag injected by
/// `web/vite.config.ts`. All three must agree; `csp_matches_headers_file`
/// below fails the build if they drift.
pub const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; \
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; \
worker-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'self'; \
form-action 'none'";

pub struct Config {
    pub assets: Assets,
    /// Serves `bench/fixtures` at `/fixtures/`, matching the Vite dev plugin so
    /// the same URLs work in a self-hosted demo.
    pub fixtures: Option<PathBuf>,
}

pub fn handle(request: Request, config: &Config) -> std::io::Result<()> {
    let response = match *request.method() {
        tiny_http::Method::Get | tiny_http::Method::Head => {
            route(request.url(), accepts_brotli(&request), config)
        }
        _ => text(405, "method not allowed"),
    };
    // tiny_http suppresses the body itself when the method is HEAD.
    request.respond(response)
}

/// Whether the client offered `br`. Assets are *stored* compressed (build.rs),
/// so this decides whether they are sent as stored or decompressed first — not
/// whether to compress. Deliberately a substring test rather than a q-value
/// parser: `Accept-Encoding: br;q=0` is not a header any browser sends, and the
/// cost of being wrong is a body the client rejects.
fn accepts_brotli(request: &Request) -> bool {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Accept-Encoding"))
        .is_some_and(|h| h.value.as_str().contains("br"))
}

fn route(url: &str, accepts_br: bool, config: &Config) -> ResponseBox {
    let path = url.split(['?', '#']).next().unwrap_or("");
    let path = path.trim_start_matches('/');
    let Some(path) = percent_decode(path) else {
        return text(400, "bad request");
    };

    if let Some(name) = path.strip_prefix("fixtures/") {
        return match &config.fixtures {
            Some(dir) => fixture(dir, name),
            None => text(
                404,
                "fixtures are not being served — start skein with --fixtures",
            ),
        };
    }

    // Normalize once: the body and the Content-Type must agree on which file
    // is being served.
    let path = normalize(&path);
    match config.assets.get(&path) {
        Some(asset) => {
            let compressed = asset.brotli && accepts_br;
            let bytes = if compressed {
                asset.bytes
            } else {
                asset.into_plain()
            };
            let len = bytes.len();
            let mut headers = common_headers(content_type(&path), cache_control(&path));
            // Vary regardless of what this response chose: the same URL can be
            // answered either way, and a shared cache must not reuse one for
            // the other.
            push_header(&mut headers, "Vary", "Accept-Encoding");
            if compressed {
                push_header(&mut headers, "Content-Encoding", "br");
            }
            Response::new(
                StatusCode(200),
                headers,
                Cursor::new(bytes),
                Some(len),
                None,
            )
            .boxed()
        }
        None => text(404, "not found"),
    }
}

fn push_header(headers: &mut Vec<Header>, name: &str, value: &str) {
    if let Ok(header) = Header::from_bytes(name.as_bytes(), value.as_bytes()) {
        headers.push(header);
    }
}

/// Fixtures are hundreds of megabytes, so they stream from disk rather than
/// being read into memory. The name check matches the Vite plugin's: a single
/// flat filename, no subdirectories.
fn fixture(dir: &std::path::Path, name: &str) -> ResponseBox {
    let valid = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    if !valid {
        return text(404, "not found");
    }
    let path = dir.join(name);
    let Ok(file) = File::open(&path) else {
        return text(404, &format!("fixture not found: {name}"));
    };
    let len = file.metadata().ok().map(|m| m.len() as usize);
    let headers = common_headers(content_type(name), "no-cache");
    Response::new(StatusCode(200), headers, file, len, None).boxed()
}

fn text(status: u16, body: &str) -> ResponseBox {
    let headers = common_headers("text/plain; charset=utf-8", "no-cache");
    let bytes = body.as_bytes().to_vec();
    let len = bytes.len();
    Response::new(
        StatusCode(status),
        headers,
        Cursor::new(bytes),
        Some(len),
        None,
    )
    .boxed()
}

fn common_headers(content_type: &str, cache_control: &str) -> Vec<Header> {
    [
        ("Content-Type", content_type),
        ("Cache-Control", cache_control),
        // SharedArrayBuffer (§8). Without these the app loses its worker fast
        // paths with no visible error.
        ("Cross-Origin-Opener-Policy", "same-origin"),
        ("Cross-Origin-Embedder-Policy", "require-corp"),
        // Privacy (§7): the served app may not talk to any other origin.
        ("Content-Security-Policy", CSP),
        ("X-Content-Type-Options", "nosniff"),
    ]
    .iter()
    .filter_map(|(k, v)| Header::from_bytes(k.as_bytes(), v.as_bytes()).ok())
    .collect()
}

pub fn run(server: Arc<Server>, config: Arc<Config>, threads: usize) {
    let mut workers = Vec::new();
    for _ in 0..threads.max(1) {
        let server = Arc::clone(&server);
        let config = Arc::clone(&config);
        workers.push(std::thread::spawn(move || {
            for request in server.incoming_requests() {
                if let Err(err) = handle(request, &config) {
                    eprintln!("skein: response failed: {err}");
                }
            }
        }));
    }
    for worker in workers {
        let _ = worker.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The CSP exists in three places (Vite's meta tag, `_headers` for static
    /// hosts, and here). Drift between them is a privacy regression that no
    /// other test would catch, because each deployment path exercises only one.
    #[test]
    fn csp_matches_headers_file() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/public/_headers");
        let contents =
            std::fs::read_to_string(path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"));
        let from_file = contents
            .lines()
            .find_map(|line| line.trim().strip_prefix("Content-Security-Policy:"))
            .expect("_headers has no Content-Security-Policy line")
            .trim();
        assert_eq!(
            from_file, CSP,
            "CSP drifted between web/public/_headers and skein-cli"
        );
    }

    #[test]
    fn every_response_carries_the_isolation_and_privacy_headers() {
        let names: Vec<String> = common_headers("text/plain", "no-cache")
            .iter()
            .map(|h| h.field.as_str().as_str().to_ascii_lowercase())
            .collect();
        for required in [
            "cross-origin-opener-policy",
            "cross-origin-embedder-policy",
            "content-security-policy",
            "x-content-type-options",
        ] {
            assert!(names.contains(&required.to_string()), "missing {required}");
        }
    }

    #[test]
    fn unknown_routes_are_404_not_index() {
        let config = Config {
            assets: Assets::Dir(PathBuf::from("/tmp/skein-nonexistent")),
            fixtures: None,
        };
        assert_eq!(
            route("/nope.js", true, &config).status_code(),
            StatusCode(404)
        );
        // Query strings are stripped before lookup, not treated as part of the path.
        assert_eq!(
            route("/nope.js?v=1", true, &config).status_code(),
            StatusCode(404)
        );
    }

    #[test]
    fn fixture_names_are_flat() {
        let dir = std::env::temp_dir();
        assert_eq!(fixture(&dir, "../secrets").status_code(), StatusCode(404));
        assert_eq!(
            fixture(&dir, "sub/graph.bin").status_code(),
            StatusCode(404)
        );
        assert_eq!(fixture(&dir, "").status_code(), StatusCode(404));
    }

    #[test]
    fn fixtures_are_refused_when_not_configured() {
        let config = Config {
            assets: Assets::Embedded,
            fixtures: None,
        };
        assert_eq!(
            route("/fixtures/tiny.bin", true, &config).status_code(),
            StatusCode(404)
        );
    }
}
