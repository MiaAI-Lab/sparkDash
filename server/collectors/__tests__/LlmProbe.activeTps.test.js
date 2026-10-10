import { test } from "node:test";
import { strict as assert } from "node:assert";

const { LlmProbe } = await import("../LlmProbe.js");

const response = (body, status = 200) => ({
  ok: status === 200,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function spark() {
  return { id: "test-win", kind: "host", platform: "windows", lanIp: "100.10.10.10" };
}

/** SSE body as async-iterable line chunks (undici yields bytes; line chunks let the
 * test control inter-chunk timing: firstDelayMs = TTFT, gapMs = decode spacing). */
function sseBody(lines, { firstDelayMs = 50, gapMs = 20 } = {}) {
  const chunks = lines.map((l) => Buffer.from(l + "\n", "utf8"));
  let i = 0;
  return {
    body: {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (i >= chunks.length) return { done: true };
            await new Promise((r) => setTimeout(r, i === 0 ? firstDelayMs : gapMs));
            return { value: chunks[i++], done: false };
          },
        };
      },
    },
  };
}

const sseLines = (n, promptTokens) => {
  const lines = ["data: " + JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })];
  for (let i = 0; i < n; i++) lines.push("data: " + JSON.stringify({ choices: [{ delta: { content: "ok " } }] }));
  lines.push("data: " + JSON.stringify({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: n } }));
  lines.push("data: [DONE]");
  return lines;
};

test("_activeTpsFromStream: decode from chunk gaps, prefill from TTFT", () => {
  // 5 content chunks, 100ms gaps → 4 tokens / 0.4s = 10 tok/s.
  // TTFT 800ms with 1600 prompt tokens → 2000 tok/s.
  const m = LlmProbe._activeTpsFromStream({ tSend: 1000, tFirst: 1800, tLast: 2200, contentChunks: 5, promptTokens: 1600 });
  assert.equal(m.decode, 10);
  assert.equal(m.prefill, 2000);
});

test("_activeTpsFromStream: a huge TTFT (queued behind traffic) skips prefill", () => {
  const m = LlmProbe._activeTpsFromStream({ tSend: 0, tFirst: 9000, tLast: 9400, contentChunks: 5, promptTokens: 1600 });
  assert.equal(m.decode, 10);
  assert.equal(m.prefill, null);
});

test("_activeTpsFromStream: single chunk (max_tokens=1) yields nothing", () => {
  const m = LlmProbe._activeTpsFromStream({ tSend: 0, tFirst: 500, tLast: 500, contentChunks: 1, promptTokens: 1600 });
  assert.equal(m.decode, null);
});

test("active probe runs for LM Studio and fills generationTps/prefillTps", async () => {
  const probe = new LlmProbe(spark(), 1234);
  probe.backendType = "lmstudio";
  probe.serverIsOpenAI = true;
  probe.models = ["ornith-1.5-35b-a3b"];
  probe._lastActiveTpsProbeAt = 0; // force the probe to run
  const fetched = [];
  probe._fetch = async (url, timeoutMs, init) => {
    fetched.push({ url: String(url), init });
    if (String(url).endsWith("/v1/models")) {
      return response({ data: [{ id: "ornith-1.5-35b-a3b", owned_by: "organization_owner" }] });
    }
    if (String(url).endsWith("/v1/chat/completions")) {
      const t = Date.now();
      const lines = sseLines(5, 1600);
      return { ok: true, status: 200, ...sseBody(lines) };
    }
    return response({}, 404);
  };
  const snap = await probe._probeOpenAICompatible();
  assert.ok(fetched.some((f) => f.url.endsWith("/v1/chat/completions")), "chat completion probe fired");
  assert.ok(snap.generationTps > 0, `generationTps=${snap.generationTps}`);
  assert.ok(snap.prefillTps > 0, `prefillTps=${snap.prefillTps}`);
  assert.equal(snap.backend, "lmstudio");
});

test("active probe is rate-limited to one request per interval", async () => {
  const probe = new LlmProbe(spark(), 1234);
  probe.backendType = "lmstudio";
  probe.serverIsOpenAI = true;
  probe.models = ["m"];
  probe._chatProbeModel = "m";
  probe._lastActiveTpsProbeAt = Date.now(); // just probed
  let chatCalls = 0;
  probe._fetch = async (url) => {
    if (String(url).endsWith("/v1/chat/completions")) chatCalls++;
    if (String(url).endsWith("/v1/models")) return response({ data: [{ id: "m" }] });
    return response({}, 404);
  };
  await probe._probeOpenAICompatible();
  assert.equal(chatCalls, 0);
});

test("embedding models are never picked as the chat-probe model", () => {
  const probe = new LlmProbe(spark(), 1234);
  probe._stashLmStudioChatModel([
    { id: "text-embedding-nomic", type: "embedding", state: "loaded" },
    { id: "ornith-1.5-35b-a3b", type: "vlm", state: "loaded" },
  ]);
  assert.equal(probe._chatProbeModel, "ornith-1.5-35b-a3b");
});
