//! A deliberately tiny HTTP/1.1 transport: one request per connection, an
//! 8 KiB head limit, bodies only up to the matched route's `max_body`, short
//! timeouts and `Connection: close`. Peers outside the `--allow` CIDRs are
//! dropped before a byte is read. What a request does is up to the
//! [`Router`](crate::routes::Router).

use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::routes::Router;

const MAX_HEAD: usize = 8 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(2);
/// Upper bound for receiving one whole request, so a slow peer can't hold a
/// listener by trickling bytes under the per-read timeout.
const REQUEST_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    /// Without the query string.
    pub path: String,
    /// Names lowercased, in arrival order.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub content_type: &'static str,
    pub headers: Vec<(&'static str, String)>,
    pub body: Arc<Vec<u8>>,
}

impl Response {
    pub fn text(status: u16, body: &str) -> Self {
        Response {
            status,
            content_type: "text/plain; charset=utf-8",
            headers: Vec::new(),
            body: Arc::new(body.as_bytes().to_vec()),
        }
    }

    pub fn json(body: Arc<Vec<u8>>) -> Self {
        Response {
            status: 200,
            content_type: "application/json",
            headers: Vec::new(),
            body,
        }
    }

    pub fn with_header(mut self, name: &'static str, value: String) -> Self {
        self.headers.push((name, value));
        self
    }
}

/// Accept loop for one listener; each connection is served inline, so the
/// agent never has more than one request in flight per listener.
pub fn serve(listener: TcpListener, allow: Arc<[Cidr]>, router: Arc<Router>) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let allowed = stream
            .peer_addr()
            .is_ok_and(|a| peer_allowed(&allow, a.ip()));
        if allowed {
            let _ = handle(stream, &router);
        }
    }
}

fn handle(mut stream: TcpStream, router: &Router) -> std::io::Result<()> {
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    let deadline = Instant::now() + REQUEST_DEADLINE;
    let response = match read_request(&mut stream, router, deadline) {
        Ok(req) => router.dispatch(&req),
        Err(resp) => resp,
    };
    write_response(&mut stream, &response)
}

fn bad_request() -> Response {
    Response::text(400, "bad request\n")
}

fn read_request(
    stream: &mut TcpStream,
    router: &Router,
    deadline: Instant,
) -> Result<Request, Response> {
    let (head, mut body) = read_head(stream, deadline).map_err(|_| bad_request())?;
    let mut req = parse_head(&head).ok_or_else(bad_request)?;
    let Some(route) = router.route_for(&req.method, &req.path) else {
        // 404 or 405: the body is never looked at.
        return Ok(req);
    };
    if !router.admits(route, &req) {
        return Err(Response::text(401, "unauthorized\n"));
    }
    let len = body_length(&req)?;
    if len > route.max_body {
        return Err(Response::text(413, "payload too large\n"));
    }
    body.truncate(len);
    let mut buf = [0u8; 4096];
    while body.len() < len {
        let want = (len - body.len()).min(buf.len());
        match read_some(stream, &mut buf[..want], deadline) {
            Ok(0) | Err(_) => return Err(bad_request()),
            Ok(n) => body.extend_from_slice(&buf[..n]),
        }
    }
    req.body = body;
    Ok(req)
}

/// Declared body size. Chunked bodies aren't supported, so a POST or PUT has
/// to say how long it is.
fn body_length(req: &Request) -> Result<usize, Response> {
    let length_required = || Response::text(411, "length required\n");
    if req.header("transfer-encoding").is_some() {
        return Err(length_required());
    }
    match req.header("content-length") {
        Some(v) => v.trim().parse().map_err(|_| bad_request()),
        None if matches!(req.method.as_str(), "POST" | "PUT") => Err(length_required()),
        None => Ok(0),
    }
}

fn read_some(stream: &mut TcpStream, buf: &mut [u8], deadline: Instant) -> std::io::Result<usize> {
    let left = deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or(ErrorKind::TimedOut)?;
    stream.set_read_timeout(Some(left.min(IO_TIMEOUT)))?;
    stream.read(buf)
}

/// The head (without the blank line) and whatever body bytes arrived with it.
fn read_head(stream: &mut TcpStream, deadline: Instant) -> std::io::Result<(Vec<u8>, Vec<u8>)> {
    let mut data = Vec::with_capacity(1024);
    let mut buf = [0u8; 1024];
    loop {
        let n = read_some(stream, &mut buf, deadline)?;
        if n == 0 {
            return Err(ErrorKind::UnexpectedEof.into());
        }
        let scan_from = data.len().saturating_sub(3);
        data.extend_from_slice(&buf[..n]);
        if let Some(i) = data[scan_from..].windows(4).position(|w| w == b"\r\n\r\n") {
            let end = scan_from + i;
            let rest = data.split_off(end + 4);
            data.truncate(end);
            return Ok((data, rest));
        }
        if data.len() > MAX_HEAD {
            return Err(ErrorKind::InvalidData.into());
        }
    }
}

pub fn parse_head(head: &[u8]) -> Option<Request> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let mut parts = lines.next()?.split(' ');
    let (method, target, version) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || !version.starts_with("HTTP/1.") || method.is_empty() {
        return None;
    }
    let path = target.split_once('?').map_or(target, |(p, _)| p);
    if !path.starts_with('/') {
        return None;
    }
    let headers = lines
        .map(|l| {
            let (k, v) = l.split_once(':')?;
            Some((k.trim().to_ascii_lowercase(), v.trim().to_string()))
        })
        .collect::<Option<Vec<_>>>()?;
    Some(Request {
        method: method.to_string(),
        path: path.to_string(),
        headers,
        body: Vec::new(),
    })
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        413 => "Content Too Large",
        _ => "Internal Server Error",
    }
}

fn write_response(stream: &mut TcpStream, r: &Response) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n",
        r.status,
        reason(r.status),
        r.content_type,
        r.body.len()
    );
    for (k, v) in &r.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(&r.body)?;
    stream.flush()
}

/// An allowed peer range like `192.0.2.0/24` or `100.64.0.0/10`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    net: u128,
    mask: u128,
}

impl Cidr {
    pub fn parse(s: &str) -> Result<Self, String> {
        let (ip, bits) = match s.split_once('/') {
            Some((ip, bits)) => (ip, Some(bits)),
            None => (s, None),
        };
        let ip: IpAddr = ip.parse().map_err(|_| format!("bad CIDR address: {s}"))?;
        let (addr, width) = to_u128(ip);
        let bits: u32 = match bits {
            Some(b) => b
                .parse()
                .ok()
                .filter(|b| *b <= width)
                .ok_or_else(|| format!("bad CIDR prefix: {s}"))?,
            None => width,
        };
        // IPv4 lives in the low 32 bits of the mapped form, so its mask
        // covers the fixed ::ffff: prefix too.
        let host_bits = width - bits;
        let mask = if host_bits >= 128 {
            0
        } else {
            u128::MAX << host_bits
        };
        Ok(Cidr {
            net: addr & mask,
            mask,
        })
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        to_u128(ip).0 & self.mask == self.net
    }
}

/// Addresses as u128, IPv4 as IPv4-mapped IPv6, with the prefix width that
/// applies to the original family.
fn to_u128(ip: IpAddr) -> (u128, u32) {
    match ip {
        IpAddr::V4(v4) => (u128::from(v4.to_ipv6_mapped()), 32),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => (u128::from(v4.to_ipv6_mapped()), 32),
            None => (u128::from(v6), 128),
        },
    }
}

pub fn peer_allowed(allow: &[Cidr], ip: IpAddr) -> bool {
    allow.is_empty() || allow.iter().any(|c| c.contains(ip))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::{Auth, Method, Route};

    #[test]
    fn parses_the_head() {
        let req = parse_head(
            b"POST /v1/x?since=5 HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer abc\r\nContent-Length: 3",
        )
        .unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, "/v1/x");
        assert_eq!(req.header("authorization"), Some("Bearer abc"));
        assert_eq!(req.header("Content-Length"), Some("3"));
        assert_eq!(req.header("content-type"), None);
        assert!(parse_head(b"GET / HTTP/2 extra").is_none());
        assert!(parse_head(b"GET / HTTP/1.1\r\nno-colon").is_none());
        assert!(parse_head(b"GET x HTTP/1.1").is_none());
        assert!(parse_head(b"garbage").is_none());
    }

    #[test]
    fn cidr_allowlist() {
        let lan = Cidr::parse("192.0.2.0/24").unwrap();
        let cgnat = Cidr::parse("100.64.0.0/10").unwrap();
        assert!(lan.contains("192.0.2.105".parse().unwrap()));
        assert!(lan.contains("::ffff:192.0.2.105".parse().unwrap()));
        assert!(!lan.contains("198.51.100.1".parse().unwrap()));
        assert!(cgnat.contains("100.127.255.255".parse().unwrap()));
        assert!(!cgnat.contains("100.128.0.1".parse().unwrap()));
        assert!(Cidr::parse("2001:db8::/32")
            .unwrap()
            .contains("2001:db8::1".parse().unwrap()));
        assert!(Cidr::parse("192.0.2.0/33").is_err());
        assert!(peer_allowed(&[], "203.0.113.1".parse().unwrap()));
        assert!(!peer_allowed(&[lan], "203.0.113.1".parse().unwrap()));
    }

    const TOKEN: &str = "test-token-0123456789abcdef";

    fn spawn_server() -> std::net::SocketAddr {
        let mut router = Router::new(TOKEN.into());
        router.add(Route {
            method: Method::Post,
            path: "/echo",
            auth: Auth::Token,
            max_body: 8,
            handler: Box::new(|req| Response::text(200, &String::from_utf8_lossy(&req.body))),
        });
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (allow, router): (Arc<[Cidr]>, _) = (Arc::from([]), Arc::new(router));
        std::thread::spawn(move || serve(listener, allow, router));
        addr
    }

    fn exchange(addr: std::net::SocketAddr, raw: &str) -> String {
        let mut s = TcpStream::connect(addr).unwrap();
        s.write_all(raw.as_bytes()).unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    #[test]
    fn bodies_are_bounded_by_the_route() {
        let addr = spawn_server();
        let auth = format!("Authorization: Bearer {TOKEN}\r\n");
        let ok = exchange(
            addr,
            &format!("POST /echo HTTP/1.1\r\n{auth}Content-Length: 5\r\n\r\nhello"),
        );
        assert!(ok.starts_with("HTTP/1.1 200 OK\r\n"), "{ok}");
        assert!(ok.ends_with("\r\n\r\nhello"));
        assert!(ok.contains("Connection: close\r\n"));

        let big = exchange(
            addr,
            &format!("POST /echo HTTP/1.1\r\n{auth}Content-Length: 9\r\n\r\n123456789"),
        );
        assert!(
            big.starts_with("HTTP/1.1 413 Content Too Large\r\n"),
            "{big}"
        );

        let no_len = exchange(addr, &format!("POST /echo HTTP/1.1\r\n{auth}\r\n"));
        assert!(
            no_len.starts_with("HTTP/1.1 411 Length Required\r\n"),
            "{no_len}"
        );

        let anon = exchange(addr, "POST /echo HTTP/1.1\r\nContent-Length: 2\r\n\r\nhi");
        assert!(anon.starts_with("HTTP/1.1 401 "), "{anon}");

        let wrong = exchange(addr, "GET /echo HTTP/1.1\r\n\r\n");
        assert!(wrong.starts_with("HTTP/1.1 405 "), "{wrong}");
        assert!(wrong.contains("Allow: POST\r\n"));

        let bad = exchange(addr, "nonsense\r\n\r\n");
        assert!(bad.starts_with("HTTP/1.1 400 "), "{bad}");
    }
}
