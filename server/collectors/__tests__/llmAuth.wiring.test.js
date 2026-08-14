/**
 * DecodeBench / Showcase must forward start({ apiKey }) into fetch.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import os from "node:os";
import path from "node:path";
import { DecodeBenchManager } from "../DecodeBench.js";
import { ShowcaseManager } from "../ShowcaseManager.js";

function sseOkResponse() {
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function waitFor(pred, timeoutMs = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting for fetch");
}

test("DecodeBenchManager.start sends Bearer on chat completions", async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), headers: opts?.headers || {} });
    return sseOkResponse();
  };
  const tmp = os.tmpdir();
  const stamp = Date.now();
  const mgr = new DecodeBenchManager(
    path.join(tmp, `sparkdash-bench-auth-${stamp}.json`),
    path.join(tmp, `sparkdash-bench-active-${stamp}.json`)
  );
  try {
    const job = mgr.start({
      sparkId: "wiring-bench",
      lanIp: "127.0.0.1",
      port: 4000,
      modelId: "qwen3.6:35b-a3b",
      concurrencies: [1],
      maxTokens: 64,
      apiKey: "test-kalliope-key",
    });
    assert.equal(job.apiKey, undefined);
    await waitFor(() =>
      seen.some((s) => String(s.url).includes("/v1/chat/completions"))
    );
    const chat = seen.find((s) => String(s.url).includes("/v1/chat/completions"));
    assert.equal(chat.headers.Authorization, "Bearer test-kalliope-key");
    mgr.cancel("wiring-bench", job.benchId);
  } finally {
    globalThis.fetch = orig;
  }
});

test("ShowcaseManager.start sends Bearer on completions and /metrics", async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), headers: opts?.headers || {} });
    if (String(url).endsWith("/metrics")) {
      return new Response("vllm:generation_tokens_total 1\n", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }
    return sseOkResponse();
  };
  const mgr = new ShowcaseManager(
    path.join(os.tmpdir(), `sparkdash-showcase-auth-${Date.now()}.json`)
  );
  try {
    const started = mgr.start({
      sparkId: "wiring-showcase",
      lanIp: "127.0.0.1",
      port: 4000,
      modelId: "qwen3.6:35b-a3b",
      prompts: ["hi"],
      maxTokens: 64,
      apiKey: "test-kalliope-key",
    });
    await waitFor(() =>
      seen.some((s) => String(s.url).includes("/v1/chat/completions"))
    );
    const chat = seen.find((s) => String(s.url).includes("/v1/chat/completions"));
    assert.equal(chat.headers.Authorization, "Bearer test-kalliope-key");
    const metrics = seen.find((s) => String(s.url).endsWith("/metrics"));
    if (metrics) {
      assert.equal(metrics.headers.Authorization, "Bearer test-kalliope-key");
    }
    mgr.cancel("wiring-showcase", started.sessionId);
  } finally {
    globalThis.fetch = orig;
  }
});
