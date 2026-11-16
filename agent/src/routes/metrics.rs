//! `GET /v1/snapshot`: the metrics document built by [`Sampler`].

use std::sync::{Arc, Mutex};

use super::{Auth, Method, Route, Router};
use crate::http::Response;
use crate::sampler::Sampler;

pub fn register(router: &mut Router, sampler: Arc<Mutex<Sampler>>) {
    router.add(Route {
        method: Method::Get,
        path: "/v1/snapshot",
        auth: Auth::Token,
        max_body: 0,
        handler: Box::new(move |_| match sampler.lock() {
            Ok(mut s) => Response::json(s.snapshot()),
            Err(_) => Response::text(500, "sampler unavailable\n"),
        }),
    });
}
