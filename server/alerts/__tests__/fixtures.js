/** Minimal SparkMonitor-shaped snapshots and helpers for the alert tests. */
import http from "node:http";
import { HealthEvaluator } from "../../health/HealthEvaluator.js";

export function unit(overrides = {}) {
  const { metrics = {}, ...rest } = overrides;
  return {
    id: "spark-1",
    name: "spark-1",
    kind: "spark",
    online: true,
    offlineReason: null,
    role: "head",
    workerNode: false,
    llmMonitoring: true,
    llmPort: 8888,
    llmPorts: [8888],
    tailscaleMonitoring: false,
    health: [],
    ...rest,
    metrics: {
      gpu: {
        temperature: 50,
        usage: 10,
        power: { draw: 20, limit: 100 },
        throttle: { active: false, reason: "ok", thermal: false, hwSlowdown: false, powerCap: false, detail: "", smClockPct: 100 },
        ...(metrics.gpu || {}),
      },
      unifiedMemory: { total: 124_610, available: 30_000, percentage: 75, ...(metrics.unifiedMemory || {}) },
      storage: metrics.storage || [{ device: "/dev/nvme0n1p2", label: "/", used: 500, total: 1000, available: 500, percentage: 50 }],
      llm: metrics.llm || [{ available: true, modelId: "m", error: null }],
      tailscale: metrics.tailscale ?? null,
    },
  };
}

/** Findings exactly as HealthEvaluator raises them for these metrics. */
export function findingsFor(metrics) {
  return new HealthEvaluator().evaluate(metrics);
}

/** A unit whose `health` is what HealthEvaluator says about its GPU temperature. */
export function hotUnit(tempC, overrides = {}) {
  return unit({ ...overrides, health: findingsFor({ gpu: { temperature: tempC } }), metrics: { gpu: { temperature: tempC } } });
}

/** A clock the test moves by hand. */
export function clock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
    return t;
  };
  now.set = (ms) => {
    t = ms;
  };
  return now;
}

/** A fetch stub that records calls and answers `status` with `body`. */
export function stubFetch(status = 200, opts = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init?.body, headers: init?.headers });
    if (opts.throws) throw opts.throws;
    return new Response(opts.body ?? "ok", { status, headers: opts.headers });
  };
  fn.calls = calls;
  return fn;
}

/** A DNS lookup stub: every name answers with `addresses`; records the names asked. */
export function stubLookup(addresses) {
  const asked = [];
  const fn = async (host) => {
    asked.push(host);
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  fn.asked = asked;
  return fn;
}

/**
 * A local HTTP receiver on 127.0.0.1. `respond(req, res)` decides the answer;
 * every request is recorded with its body.
 */
export async function receiver(respond = (_req, res) => res.end("ok")) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      respond(req, res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { port, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A secret-looking string a hostile or chatty server might answer with. */
export const LEAK = "sk-live-LEAKED-0123456789abcdef";

export const quietLog = { error() {}, warn() {}, log() {} };
