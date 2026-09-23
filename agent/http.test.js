import test from "node:test";
import assert from "node:assert/strict";
import { createHttpServer } from "./http.js";

const SNAPSHOT = {
  nodeId: "narthex",
  nodeName: "Narthex",
  lanIp: "192.168.50.150",
  agentVersion: "0.1.0",
  online: true,
  uptimeSeconds: 100,
  gpu: null,
  cpu: null,
  mem: null,
  disk: [],
  net: [],
  containers: [{ name: "c1", image: "img:1", imageDigest: null, status: "running", uptimeSeconds: 5, ports: [], memUsedMB: null, memLimitMB: null, cpuPercent: null }],
  versions: [{ serviceName: "llm:8080", kind: "llm", engine: "vllm", engineVersion: null, modelId: "m", modelPath: null, modelRevision: null, quantization: null, contextLength: 1000, memFraction: null, tpSize: null, port: 8080, state: "running", polledAt: 1 }],
  services: [],
  memory: null,
  requests: null,
  topology: null,
  polledAt: 1,
};

async function withServer(opts, fn) {
  let calls = 0;
  const server = createHttpServer(async () => {
    calls += 1;
    return SNAPSHOT;
  }, 0, "127.0.0.1", opts);
  const addr = await server.start();
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(base, calls, () => calls);
  } finally {
    await server.stop();
  }
}

test("http: identity + health endpoints", async () => {
  await withServer({ agentVersion: "0.1.0" }, async (base) => {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.equal(root.headers.get("content-type"), "application/json");
    assert.deepEqual(await root.json(), {
      name: "sparkdash-node-agent",
      version: "0.1.0",
      endpoints: ["/telemetry", "/versions", "/containers", "/health"],
    });

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, agentVersion: "0.1.0" });
  });
});

test("http: /telemetry, /versions, /containers return live snapshot slices", async () => {
  await withServer({}, async (base, _calls, getCalls) => {
    const t = await (await fetch(`${base}/telemetry`)).json();
    assert.equal(t.nodeId, "narthex");
    assert.equal(getCalls(), 1);

    const v = await (await fetch(`${base}/versions`)).json();
    assert.deepEqual(v, SNAPSHOT.versions);

    const c = await (await fetch(`${base}/containers`)).json();
    assert.deepEqual(c, SNAPSHOT.containers);
  });
});

test("http: CORS allows all origins; OPTIONS preflight handled", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/telemetry`);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const pre = await fetch(`${base}/telemetry`, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
  });
});

test("http: unknown route → 404 JSON; non-GET → 405 JSON", async () => {
  await withServer({}, async (base) => {
    const nf = await fetch(`${base}/nope`);
    assert.equal(nf.status, 404);
    assert.deepEqual(await nf.json(), { error: "not found" });
    const bad = await fetch(`${base}/telemetry`, { method: "POST" });
    assert.equal(bad.status, 405);
  });
});

test("http: snapshotFn failure → 500 JSON (no hang, no crash)", async () => {
  const server = createHttpServer(
    async () => {
      throw new Error("boom");
    },
    0,
    "127.0.0.1"
  );
  const addr = await server.start();
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/telemetry`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, "telemetry failed");
    assert.match(body.message, /boom/);
  } finally {
    await server.stop();
  }
});

test("http: bearer token knob (non-default) guards data endpoints, leaves /health open", async () => {
  await withServer({ token: "sekret" }, async (base) => {
    const open = await fetch(`${base}/health`);
    assert.equal(open.status, 200);

    const denied = await fetch(`${base}/telemetry`);
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: "unauthorized" });

    const wrong = await fetch(`${base}/telemetry`, {
      headers: { authorization: "Bearer wrong" },
    });
    assert.equal(wrong.status, 401);

    const ok = await fetch(`${base}/telemetry`, {
      headers: { authorization: "Bearer sekret" },
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).nodeId, "narthex");
  });
});

test("http: stop() closes the listener (subsequent connect fails)", async () => {
  const server = createHttpServer(async () => ({}), 0, "127.0.0.1");
  const addr = await server.start();
  await server.stop();
  await assert.rejects(
    fetch(`http://127.0.0.1:${addr.port}/health`),
    /fetch failed|ECONNREFUSED/
  );
  // stop() is idempotent
  await server.stop();
});
