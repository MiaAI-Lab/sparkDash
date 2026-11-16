//! sparkdash-agent: a read-only metrics agent for sparkDash units.
//!
//! It reads /proc, /sys, /dev/kmsg and NVML in-process and serves the result
//! over token-gated HTTP on the addresses it is told to bind, so the dashboard
//! needs no SSH session per metric. See README.md.

mod gpu;
mod http;
mod kmsg;
mod procfs;
mod routes;
mod sampler;
mod sysfs;

use std::net::{SocketAddr, TcpListener};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use http::Cidr;
use routes::Router;
use sampler::{RdmaSampler, Sampler};

const USAGE: &str = "\
usage: sparkdash-agent --listen IP:PORT [--listen IP:PORT ...] [options]

  --listen IP:PORT       address to serve on (repeatable; a LAN or tailnet IP,
                         never 0.0.0.0 or ::). Retried until the address exists.
  --allow CIDR           only answer peers in this range (repeatable)
  --token-file PATH      bearer token file, at least 24 characters
                         (default $CREDENTIALS_DIRECTORY/token)
  --min-interval-ms N    minimum time between samples (default and floor 1000)
  --version              print the version and exit
";

#[derive(Debug)]
struct Args {
    listen: Vec<SocketAddr>,
    allow: Vec<Cidr>,
    token_file: Option<PathBuf>,
    min_interval: Duration,
}

enum Exit {
    Usage(String),
    Version,
}

fn parse_args(mut it: impl Iterator<Item = String>) -> Result<Args, Exit> {
    let mut a = Args {
        listen: Vec::new(),
        allow: Vec::new(),
        token_file: None,
        min_interval: Duration::from_millis(1000),
    };
    while let Some(flag) = it.next() {
        let mut value = || {
            it.next()
                .ok_or_else(|| Exit::Usage(format!("{flag} needs a value")))
        };
        match flag.as_str() {
            "--listen" => {
                let v = value()?;
                let addr: SocketAddr = v
                    .parse()
                    .map_err(|_| Exit::Usage(format!("--listen: bad address {v}")))?;
                if addr.ip().is_unspecified() {
                    return Err(Exit::Usage(format!(
                        "--listen {v}: bind a specific LAN or tailnet address"
                    )));
                }
                a.listen.push(addr);
            }
            "--allow" => a.allow.push(Cidr::parse(&value()?).map_err(Exit::Usage)?),
            "--token-file" => a.token_file = Some(value()?.into()),
            "--min-interval-ms" => {
                let v = value()?;
                let ms: u64 = v
                    .parse()
                    .map_err(|_| Exit::Usage(format!("--min-interval-ms: not a number: {v}")))?;
                a.min_interval = Duration::from_millis(ms.max(1000));
            }
            "-V" | "--version" => return Err(Exit::Version),
            "-h" | "--help" => return Err(Exit::Usage(String::new())),
            other => return Err(Exit::Usage(format!("unknown option {other}"))),
        }
    }
    if a.listen.is_empty() {
        return Err(Exit::Usage("at least one --listen is required".into()));
    }
    Ok(a)
}

fn load_token(path: Option<PathBuf>) -> Result<String, String> {
    let path = path
        .or_else(|| {
            std::env::var_os("CREDENTIALS_DIRECTORY").map(|d| PathBuf::from(d).join("token"))
        })
        .ok_or("no --token-file and no systemd credential named token")?;
    let token = std::fs::read_to_string(&path)
        .map_err(|e| format!("token file {}: {e}", path.display()))?
        .trim()
        .to_string();
    if token.len() < 24 {
        return Err(format!(
            "token in {} is shorter than 24 characters",
            path.display()
        ));
    }
    Ok(token)
}

fn main() {
    let args = match parse_args(std::env::args().skip(1)) {
        Ok(a) => a,
        Err(Exit::Version) => {
            println!("sparkdash-agent {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Err(Exit::Usage(e)) => {
            if !e.is_empty() {
                eprintln!("sparkdash-agent: {e}");
            }
            eprint!("{USAGE}");
            std::process::exit(2);
        }
    };
    let token = load_token(args.token_file.clone()).unwrap_or_else(|e| {
        eprintln!("sparkdash-agent: {e}");
        std::process::exit(2);
    });

    let kernel_log = Arc::new(Mutex::new(None));
    kmsg::spawn(Arc::clone(&kernel_log));

    let sampler = Arc::new(Mutex::new(Sampler::new(args.min_interval, kernel_log)));
    let mut router = Router::new(token);
    let rdma = Arc::new(Mutex::new(RdmaSampler::new(args.min_interval)));
    routes::metrics::register(&mut router, sampler, rdma);
    let router = Arc::new(router);
    let allow: Arc<[Cidr]> = args.allow.into();

    let handles: Vec<_> = args
        .listen
        .iter()
        .map(|addr| {
            let (addr, allow, router) = (*addr, Arc::clone(&allow), Arc::clone(&router));
            std::thread::Builder::new()
                .name(format!("http {addr}"))
                .spawn(move || http::serve(bind_when_ready(addr), allow, router))
                .expect("spawn listener")
        })
        .collect();
    eprintln!(
        "sparkdash-agent {} serving on {:?}",
        env!("CARGO_PKG_VERSION"),
        args.listen
    );
    for h in handles {
        let _ = h.join();
    }
}

/// A tailnet address doesn't exist until tailscaled is up, so keep trying.
fn bind_when_ready(addr: SocketAddr) -> TcpListener {
    let mut warned = false;
    loop {
        match TcpListener::bind(addr) {
            Ok(l) => {
                if warned {
                    eprintln!("sparkdash-agent: now listening on {addr}");
                }
                return l;
            }
            Err(e) => {
                if !warned {
                    eprintln!("sparkdash-agent: can't bind {addr} yet ({e}); retrying every 5 s");
                    warned = true;
                }
                std::thread::sleep(Duration::from_secs(5));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Result<Args, Exit> {
        parse_args(list.iter().map(|s| s.to_string()))
    }

    #[test]
    fn refuses_wildcard_binds_and_enforces_the_rate_floor() {
        assert!(args(&["--listen", "0.0.0.0:9110"]).is_err());
        assert!(args(&["--listen", "[::]:9110"]).is_err());
        assert!(args(&[]).is_err());
        assert!(args(&["--listen", "192.0.2.10:9110", "--docker"]).is_err());
        assert!(matches!(args(&["--version"]), Err(Exit::Version)));
        let a = args(&[
            "--listen",
            "192.0.2.10:9110",
            "--listen",
            "[2001:db8::1]:9110",
            "--allow",
            "192.0.2.0/24",
            "--min-interval-ms",
            "10",
        ])
        .ok()
        .unwrap();
        assert_eq!(a.listen.len(), 2);
        assert_eq!(a.allow.len(), 1);
        assert_eq!(a.min_interval, Duration::from_millis(1000));
        let a = args(&["--listen", "127.0.0.1:1", "--min-interval-ms", "2500"])
            .ok()
            .unwrap();
        assert_eq!(a.min_interval, Duration::from_millis(2500));
    }

    #[test]
    fn token_needs_24_characters() {
        let dir = sysfs::testdir::TestDir::new();
        dir.write("short", "abc\n");
        dir.write("ok", &format!("{}\n", "x".repeat(24)));
        assert!(load_token(Some(dir.path().join("short"))).is_err());
        assert!(load_token(Some(dir.path().join("missing"))).is_err());
        assert_eq!(
            load_token(Some(dir.path().join("ok"))).unwrap(),
            "x".repeat(24)
        );
    }
}
