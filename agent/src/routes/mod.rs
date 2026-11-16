//! Routing: each feature module registers its routes on a [`Router`], which
//! answers unknown paths with 404, other methods on a known path with 405 plus
//! `Allow`, and token routes without the bearer token with 401.

pub mod metrics;

use crate::http::{Request, Response};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Delete,
}

impl Method {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "GET" => Some(Method::Get),
            "POST" => Some(Method::Post),
            "PUT" => Some(Method::Put),
            "DELETE" => Some(Method::Delete),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Put => "PUT",
            Method::Delete => "DELETE",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Auth {
    Public,
    /// Needs `Authorization: Bearer <token>`.
    Token,
}

pub type Handler = Box<dyn Fn(&Request) -> Response + Send + Sync>;

pub struct Route {
    pub method: Method,
    pub path: &'static str,
    pub auth: Auth,
    /// Largest accepted request body in bytes; larger requests get 413
    /// before the body is read.
    pub max_body: usize,
    pub handler: Handler,
}

pub struct Router {
    token: String,
    routes: Vec<Route>,
}

impl Router {
    pub fn new(token: String) -> Self {
        let mut router = Router {
            token,
            routes: Vec::new(),
        };
        router.add(Route {
            method: Method::Get,
            path: "/healthz",
            auth: Auth::Public,
            max_body: 0,
            handler: Box::new(|_| Response::text(200, "ok\n")),
        });
        router
    }

    pub fn add(&mut self, route: Route) {
        self.routes.push(route);
    }

    pub fn route_for(&self, method: &str, path: &str) -> Option<&Route> {
        self.routes
            .iter()
            .find(|r| r.path == path && Some(r.method) == Method::parse(method))
    }

    pub fn admits(&self, route: &Route, req: &Request) -> bool {
        route.auth == Auth::Public || authorized(req.header("authorization"), &self.token)
    }

    pub fn dispatch(&self, req: &Request) -> Response {
        if let Some(route) = self.route_for(&req.method, &req.path) {
            if !self.admits(route, req) {
                return Response::text(401, "unauthorized\n");
            }
            return (route.handler)(req);
        }
        let allowed: Vec<&str> = self
            .routes
            .iter()
            .filter(|r| r.path == req.path)
            .map(|r| r.method.as_str())
            .collect();
        if allowed.is_empty() {
            return Response::text(404, "not found\n");
        }
        Response::text(405, "method not allowed\n").with_header("Allow", allowed.join(", "))
    }
}

/// Constant-time comparison of the bearer token.
pub fn authorized(header: Option<&str>, token: &str) -> bool {
    let Some(given) = header.and_then(|h| h.strip_prefix("Bearer ")) else {
        return false;
    };
    let (a, b) = (given.trim().as_bytes(), token.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: &str, path: &str, auth: Option<&str>) -> Request {
        Request {
            method: method.into(),
            path: path.into(),
            headers: auth
                .map(|t| vec![("authorization".to_string(), format!("Bearer {t}"))])
                .unwrap_or_default(),
            body: Vec::new(),
        }
    }

    fn router() -> Router {
        let mut r = Router::new("s3cret-token".into());
        for method in [Method::Get, Method::Delete] {
            r.add(Route {
                method,
                path: "/v1/thing",
                auth: Auth::Token,
                max_body: 0,
                handler: Box::new(move |_| Response::text(200, method.as_str())),
            });
        }
        r
    }

    #[test]
    fn dispatch_statuses() {
        let r = router();
        assert_eq!(r.dispatch(&request("GET", "/nope", None)).status, 404);
        let health = r.dispatch(&request("GET", "/healthz", None));
        assert_eq!((health.status, health.body.as_slice()), (200, &b"ok\n"[..]));

        let wrong = r.dispatch(&request("POST", "/v1/thing", Some("s3cret-token")));
        assert_eq!(wrong.status, 405);
        assert_eq!(wrong.headers, vec![("Allow", "GET, DELETE".to_string())]);
        let head = r.dispatch(&request("HEAD", "/healthz", None));
        assert_eq!(head.headers, vec![("Allow", "GET".to_string())]);

        assert_eq!(r.dispatch(&request("GET", "/v1/thing", None)).status, 401);
        assert_eq!(
            r.dispatch(&request("GET", "/v1/thing", Some("wrong")))
                .status,
            401
        );
        let ok = r.dispatch(&request("DELETE", "/v1/thing", Some("s3cret-token")));
        assert_eq!((ok.status, ok.body.as_slice()), (200, &b"DELETE"[..]));
        assert_eq!(r.route_for("GET", "/v1/thing").map(|r| r.max_body), Some(0));
    }

    #[test]
    fn token_must_match_exactly() {
        assert!(authorized(Some("Bearer s3cret-token"), "s3cret-token"));
        assert!(!authorized(Some("Bearer s3cret-toke"), "s3cret-token"));
        assert!(!authorized(Some("s3cret-token"), "s3cret-token"));
        assert!(!authorized(None, "s3cret-token"));
    }
}
