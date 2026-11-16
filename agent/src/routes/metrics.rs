//! `GET /v1/snapshot`, the metrics document built by [`Sampler`], and
//! `GET /v1/rdma`, the slower RDMA/RoCE counters built by [`RdmaSampler`].

use std::sync::{Arc, Mutex};

use super::{Auth, Method, Route, Router};
use crate::http::Response;
use crate::sampler::{RdmaSampler, Sampler};

pub fn register(router: &mut Router, sampler: Arc<Mutex<Sampler>>, rdma: Arc<Mutex<RdmaSampler>>) {
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
    router.add(Route {
        method: Method::Get,
        path: "/v1/rdma",
        auth: Auth::Token,
        max_body: 0,
        handler: Box::new(move |_| match rdma.lock() {
            Ok(mut s) => Response::json(s.document()),
            Err(_) => Response::text(500, "sampler unavailable\n"),
        }),
    });
}
