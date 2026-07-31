//! `skein` — serves the skein web app from a single binary.
//!
//! The app is a browser app and stays one: this ships it to the user's real
//! browser rather than wrapping it in an embedded webview, because the whole
//! renderer and force sim are built on WebGPU (D7, D9) and system webviews do
//! not reliably have it. See docs/DECISIONS.md D10.

mod assets;
mod server;

use std::io::IsTerminal;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use assets::Assets;
use server::Config;

/// A fixed default port, deliberately. Graphs are persisted to OPFS, which is
/// keyed by origin — and the origin includes the port. Drifting to an ephemeral
/// port on each start would silently orphan every graph the user had ingested.
const DEFAULT_PORT: u16 = 7373;

const HELP: &str = "\
skein — view large graphs locally; your data never leaves your machine

USAGE:
    skein [serve] [OPTIONS]

OPTIONS:
        --host <ADDR>     Address to bind [default: 127.0.0.1]
        --port <PORT>     Port to bind [default: 7373]
        --web-root <DIR>  Serve this directory instead of the embedded app
        --fixtures <DIR>  Also serve this directory at /fixtures/
        --open            Open a browser (default when bound to loopback)
        --no-open         Never open a browser
        --threads <N>     Request handler threads [default: cores, max 8]
    -h, --help            Print help
    -V, --version         Print version

The port is fixed rather than chosen at random because ingested graphs are
stored per-origin in the browser; changing the port hides them.
";

struct Args {
    host: String,
    port: u16,
    web_root: Option<PathBuf>,
    fixtures: Option<PathBuf>,
    open: Option<bool>,
    threads: Option<usize>,
}

fn main() -> ExitCode {
    let args = match parse_args(std::env::args().skip(1)) {
        Ok(Some(args)) => args,
        Ok(None) => return ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("skein: {err}\n\n{HELP}");
            return ExitCode::FAILURE;
        }
    };

    match run(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("skein: {err}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: Args) -> Result<(), String> {
    let assets = match &args.web_root {
        Some(dir) if !dir.is_dir() => {
            return Err(format!("--web-root {} is not a directory", dir.display()))
        }
        Some(dir) => Assets::Dir(dir.clone()),
        None => Assets::Embedded,
    };
    if assets.is_empty() {
        return Err(
            "this binary was built without an embedded web app. Build it with \
             `npm run build` before `cargo build`, or point --web-root at web/dist."
                .into(),
        );
    }
    if let Some(dir) = &args.fixtures {
        if !dir.is_dir() {
            return Err(format!("--fixtures {} is not a directory", dir.display()));
        }
    }

    let host: IpAddr = args
        .host
        .parse()
        .map_err(|_| format!("--host {} is not an IP address", args.host))?;
    let addr = SocketAddr::new(host, args.port);

    let server = tiny_http::Server::http(addr).map_err(|err| {
        format!(
            "cannot bind {addr}: {err}. Another skein may already be running — \
                 reuse it, or pass --port (note that a different port hides graphs \
                 saved under the default one)."
        )
    })?;

    let threads = args.threads.unwrap_or_else(default_threads).max(1);
    let url = format!("http://{}:{}/", display_host(host), args.port);
    println!(
        "skein {} — serving {}",
        env!("CARGO_PKG_VERSION"),
        assets.describe()
    );
    if let Some(dir) = &args.fixtures {
        println!("  fixtures: {} -> /fixtures/", dir.display());
    }
    println!("  {url}");
    println!("  no data leaves this machine; press ctrl-c to stop");

    if args
        .open
        .unwrap_or_else(|| host.is_loopback() && std::io::stdout().is_terminal())
    {
        open_browser(&url);
    }

    server::run(
        Arc::new(server),
        Arc::new(Config {
            assets,
            fixtures: args.fixtures,
        }),
        threads,
    );
    Ok(())
}

fn display_host(host: IpAddr) -> String {
    // 0.0.0.0 and :: are bind addresses, not addresses you can visit.
    if host.is_unspecified() {
        "localhost".into()
    } else if host.is_ipv6() {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

fn default_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4)
}

fn open_browser(url: &str) {
    let (program, args): (&str, &[&str]) = if cfg!(target_os = "macos") {
        ("open", &[])
    } else if cfg!(target_os = "windows") {
        ("cmd", &["/C", "start", ""])
    } else {
        ("xdg-open", &[])
    };
    let spawned = std::process::Command::new(program)
        .args(args)
        .arg(url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    if spawned.is_err() {
        println!("  (could not open a browser automatically — visit the URL above)");
    }
}

fn parse_args(args: impl Iterator<Item = String>) -> Result<Option<Args>, String> {
    let mut parsed = Args {
        host: "127.0.0.1".into(),
        port: DEFAULT_PORT,
        web_root: None,
        fixtures: None,
        open: None,
        threads: None,
    };
    let mut args = args.peekable();
    // `serve` is the only subcommand and is optional; accepting it leaves room
    // for others later without breaking the short form.
    if args.peek().map(String::as_str) == Some("serve") {
        args.next();
    }
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "-h" | "--help" => {
                print!("{HELP}");
                return Ok(None);
            }
            "-V" | "--version" => {
                println!("skein {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            "--host" => parsed.host = value()?,
            "--port" => {
                let raw = value()?;
                parsed.port = raw
                    .parse()
                    .map_err(|_| format!("--port {raw} is not a port number"))?;
            }
            "--web-root" => parsed.web_root = Some(PathBuf::from(value()?)),
            "--fixtures" => parsed.fixtures = Some(PathBuf::from(value()?)),
            "--open" => parsed.open = Some(true),
            "--no-open" => parsed.open = Some(false),
            "--threads" => {
                let raw = value()?;
                parsed.threads = Some(
                    raw.parse()
                        .map_err(|_| format!("--threads {raw} is not a number"))?,
                );
            }
            other => return Err(format!("unexpected argument {other}")),
        }
    }
    Ok(Some(parsed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(argv: &[&str]) -> Result<Option<Args>, String> {
        parse_args(argv.iter().map(|s| s.to_string()))
    }

    #[test]
    fn defaults_to_loopback_on_the_fixed_port() {
        let args = parse(&[]).unwrap().unwrap();
        assert_eq!(args.host, "127.0.0.1");
        assert_eq!(args.port, DEFAULT_PORT);
        assert_eq!(args.open, None);
    }

    #[test]
    fn accepts_the_optional_serve_subcommand() {
        let args = parse(&["serve", "--port", "9000"]).unwrap().unwrap();
        assert_eq!(args.port, 9000);
    }

    #[test]
    fn rejects_bad_input_rather_than_guessing() {
        assert!(parse(&["--port", "notaport"]).is_err());
        assert!(parse(&["--port"]).is_err());
        assert!(parse(&["--nonsense"]).is_err());
    }

    #[test]
    fn help_and_version_stop_before_serving() {
        assert!(parse(&["--help"]).unwrap().is_none());
        assert!(parse(&["-V"]).unwrap().is_none());
    }

    #[test]
    fn bind_addresses_are_not_shown_as_visitable_urls() {
        assert_eq!(display_host("0.0.0.0".parse().unwrap()), "localhost");
        assert_eq!(display_host("127.0.0.1".parse().unwrap()), "127.0.0.1");
        assert_eq!(display_host("::1".parse().unwrap()), "[::1]");
    }
}
