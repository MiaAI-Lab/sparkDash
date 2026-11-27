import test from "node:test";
import assert from "node:assert/strict";
import { firstModelId, registerChatRoutes, resolveChatModel } from "../chat.js";

function setup(opts = {}) {
  let handler;
  registerChatRoutes({ post: (_path, fn) => { handler = fn; } }, opts);
  const call = async (body = {}, { remoteAddress = "127.0.0.1" } = {}) => {
    const res = {
      statusCode: 200,
      headers: {},
      chunks: [],
      ended: false,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; },
      writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
      write(chunk) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); },
      end(chunk) { if (chunk) this.write(chunk); this.ended = true; },
      on() { return this; },
    };
    await handler({ body, ip: remoteAddress, socket: { remoteAddress } }, res);
    return res;
  };
  return { call };
}

function sseChunk(model, content) {
  return `data: ${JSON.stringify({
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: { content } }],
  })}\n\n`;
}

function mockFetch(routes) {
  return async (url, init = {}) => {
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route(init);
  };
}

test("firstModelId reads OpenAI and Ollama-shaped lists", () => {
  assert.equal(firstModelId({ data: [{ id: "alpha" }, { id: "beta" }] }), "alpha");
  assert.equal(firstModelId({ models: [{ name: "local" }] }), "local");
  assert.equal(firstModelId({ data: [] }), null);
});

test("resolveChatModel prefers the request, then CHAT_MODEL, then /v1/models", async () => {
  const fetchImpl = mockFetch({
    "/v1/models": async () => ({ ok: true, json: async () => ({ data: [{ id: "discovered" }] }) }),
  });
  assert.deepEqual(
    await resolveChatModel({ port: 8888, requested: "from-request", env: { CHAT_MODEL: "from-env" }, fetchImpl }),
    { model: "from-request", from: "request" },
  );
  assert.deepEqual(
    await resolveChatModel({ port: 8888, env: { CHAT_MODEL: "from-env" }, fetchImpl }),
    { model: "from-env", from: "env" },
  );
  assert.deepEqual(
    await resolveChatModel({ port: 8888, env: {}, fetchImpl }),
    { model: "discovered", from: "models" },
  );
});

test("POST /api/chat validates the message, discovers the model, streams, and forwards an API key", async () => {
  const seen = [];
  const fetchImpl = mockFetch({
    "/v1/models": async (init) => {
      seen.push(["models", init.headers]);
      return { ok: true, json: async () => ({ data: [{ id: "discovered-model" }] }) };
    },
    "/v1/chat/completions": async (init) => {
      seen.push(["chat", init.headers, JSON.parse(init.body)]);
      return {
        ok: true,
        body: (async function* () { yield Buffer.from(sseChunk("discovered-model", "hello")); })(),
      };
    },
  });
  const { call } = setup({ port: 8888, getApiKey: () => "secret-key", fetchImpl, env: {}, allow: () => true });
  assert.equal((await call({})).statusCode, 400);
  assert.equal((await call({ message: "   " })).statusCode, 400);
  assert.equal((await call({ message: "x".repeat(20_001) })).statusCode, 400);
  const res = await call({ message: "Say hi" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "text/event-stream");
  assert.match(Buffer.concat(res.chunks).toString(), /hello/);
  assert.equal(seen[0][0], "models");
  assert.equal(seen[0][1].Authorization, "Bearer secret-key");
  assert.equal(seen[1][0], "chat");
  assert.equal(seen[1][1].Authorization, "Bearer secret-key");
  assert.equal(seen[1][2].model, "discovered-model");
  assert.deepEqual(seen[1][2].messages, [{ role: "user", content: "Say hi" }]);
});

test("POST /api/chat honours CHAT_MODEL and the rate limiter", async () => {
  const fetchImpl = mockFetch({
    "/v1/chat/completions": async (init) => {
      const body = JSON.parse(init.body);
      return {
        ok: true,
        body: (async function* () { yield Buffer.from(sseChunk(body.model, "ok")); })(),
      };
    },
  });
  let allowed = true;
  const { call } = setup({ fetchImpl, env: { CHAT_MODEL: "pinned" }, allow: () => allowed });
  const ok = await call({ message: "Hi" });
  assert.equal(ok.statusCode, 200);
  assert.match(Buffer.concat(ok.chunks).toString(), /pinned/);
  allowed = false;
  const limited = await call({ message: "Hi" });
  assert.equal(limited.statusCode, 429);
  assert.match(limited.body.error, /Too many chat requests/);
});
