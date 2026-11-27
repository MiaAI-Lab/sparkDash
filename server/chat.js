// Chat proxy: POST /api/chat forwards one message to the local OpenAI-compatible
// server (LLM_PORT on loopback) and streams the reply back as server-sent events.
import { createRateLimiter } from "./validate.js";

const MAX_MESSAGE_CHARS = 20_000;
const DEFAULT_MAX_TOKENS = 512;
const MAX_TOKENS = 4096;
const MAX_MODEL_CHARS = 200;

const defaultAllow = createRateLimiter(20, 60_000);
const inFlight = new Set();

function clientAddress(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function bearerHeaders(apiKey) {
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/** First model id from an OpenAI-compatible /v1/models body, or null. */
export function firstModelId(body) {
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  for (const row of rows) {
    const id = typeof row === "string" ? row : row?.id || row?.name;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return null;
}

/**
 * Prefer an explicit request or CHAT_MODEL override; otherwise read /v1/models.
 * @returns {Promise<{model: string, from: "request" | "env" | "models"}>}
 */
export async function resolveChatModel({ port, apiKey, requested, env = process.env, fetchImpl = fetch, signal } = {}) {
  const fromRequest = typeof requested === "string" ? requested.trim() : "";
  if (fromRequest) {
    if (fromRequest.length > MAX_MODEL_CHARS) {
      const err = new Error("model is too long");
      err.status = 400;
      throw err;
    }
    return { model: fromRequest, from: "request" };
  }
  const fromEnv = typeof env.CHAT_MODEL === "string" ? env.CHAT_MODEL.trim() : "";
  if (fromEnv) return { model: fromEnv.slice(0, MAX_MODEL_CHARS), from: "env" };
  let res;
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}/v1/models`, {
      headers: bearerHeaders(apiKey),
      signal,
    });
  } catch (err) {
    const wrapped = new Error(`LLM server on port ${port} unreachable: ${err.message}`);
    wrapped.status = 502;
    throw wrapped;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`LLM server returned HTTP ${res.status} from /v1/models: ${text.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }
  const body = await res.json().catch(() => ({}));
  const model = firstModelId(body);
  if (!model) {
    const err = new Error("LLM server reported no models; set CHAT_MODEL to choose one");
    err.status = 502;
    throw err;
  }
  return { model, from: "models" };
}

export function registerChatRoutes(app, {
  port = Number(process.env.LLM_PORT) || 8888,
  getApiKey = () => null,
  allow = (req) => defaultAllow(clientAddress(req)),
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  app.post("/api/chat", async (req, res) => {
    if (!allow(req)) {
      return res.status(429).json({ error: "Too many chat requests; wait and try again" });
    }
    const key = clientAddress(req);
    if (inFlight.has(key)) {
      return res.status(429).json({ error: "A chat reply is already in progress; wait for it to finish" });
    }
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) return res.status(400).json({ error: "message is required" });
    if (message.length > MAX_MESSAGE_CHARS) return res.status(400).json({ error: "message is too long" });
    const maxTokens = Math.min(Math.max(Number(req.body?.maxTokens) || DEFAULT_MAX_TOKENS, 1), MAX_TOKENS);
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    const apiKey = getApiKey(req) || null;
    inFlight.add(key);
    try {
      let resolved;
      try {
        resolved = await resolveChatModel({
          port,
          apiKey,
          requested: req.body?.model,
          env,
          fetchImpl,
          signal: ac.signal,
        });
      } catch (err) {
        if (ac.signal.aborted) return;
        return res.status(err.status || 502).json({ error: err.message });
      }
      const headers = { "Content-Type": "application/json", ...bearerHeaders(apiKey) };
      let upstream;
      try {
        upstream = await fetchImpl(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: resolved.model,
            messages: [{ role: "user", content: message }],
            max_tokens: maxTokens,
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: ac.signal,
        });
      } catch (err) {
        if (ac.signal.aborted) return;
        return res.status(502).json({ error: `LLM server on port ${port} unreachable: ${err.message}` });
      }
      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => "");
        return res.status(502).json({ error: `LLM server returned HTTP ${upstream.status}: ${text.slice(0, 300)}` });
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      try {
        for await (const chunk of upstream.body) res.write(chunk);
      } catch {
        /* client went away or upstream closed */
      }
      res.end();
    } finally {
      inFlight.delete(key);
    }
  });
}
