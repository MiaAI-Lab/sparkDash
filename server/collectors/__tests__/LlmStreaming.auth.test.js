/**
 * Streaming and /metrics helpers must send the same Bearer key LlmProbe uses.
 * Authenticated LiteLLM/OpenAI-compatible gateways return HTTP 401 without it.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  readServerGenerationTokens,
  runStreamingRequest,
} from "../LlmStreaming.js";

function sseOkResponse() {
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("runStreamingRequest sends Authorization Bearer when apiKey is set", async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    seen.push(opts?.headers || {});
    return sseOkResponse();
  };
  try {
    await runStreamingRequest(
      "http://example.invalid/v1/chat/completions",
      { model: "qwen3.6:35b-a3b", messages: [{ role: "user", content: "hi" }] },
      AbortSignal.timeout(2000),
      { apiKey: "test-kalliope-key" }
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].Authorization, "Bearer test-kalliope-key");
    assert.equal(seen[0]["Content-Type"], "application/json");
  } finally {
    globalThis.fetch = orig;
  }
});

test("runStreamingRequest omits Authorization when apiKey is absent", async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    seen.push(opts?.headers || {});
    return sseOkResponse();
  };
  try {
    await runStreamingRequest(
      "http://example.invalid/v1/chat/completions",
      { model: "dspark", messages: [{ role: "user", content: "hi" }] },
      AbortSignal.timeout(2000),
      {}
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].Authorization, undefined);
  } finally {
    globalThis.fetch = orig;
  }
});

test("readServerGenerationTokens sends Authorization Bearer when apiKey is set", async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    seen.push(opts?.headers || {});
    return new Response("vllm:generation_tokens_total 12\n", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  };
  try {
    const tokens = await readServerGenerationTokens("http://example.invalid", {
      apiKey: "test-kalliope-key",
    });
    assert.equal(tokens, 12);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].Authorization, "Bearer test-kalliope-key");
  } finally {
    globalThis.fetch = orig;
  }
});

test("readServerGenerationTokens omits Authorization when apiKey is absent", async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    seen.push(opts?.headers || {});
    return new Response("vllm:generation_tokens_total 3\n", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  };
  try {
    await readServerGenerationTokens("http://example.invalid");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].Authorization, undefined);
  } finally {
    globalThis.fetch = orig;
  }
});
