import fs from "node:fs";
import { authenticate, configuredToken, requireRemoteAuth } from "../auth.js";
import { ClipboardError, ClipboardStore, isClipboardId } from "./store.js";

export const MAX_WAIT_MS = 30_000;
const DEVICE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Who wrote an entry. Device agents name themselves with `X-Clipboard-Device`; anything
 * else is a browser. The name is a label for people, never an identity check.
 */
export function sourceOf(req) {
  const device = String(req.headers["x-clipboard-device"] ?? "").trim();
  return DEVICE_RE.test(device) ? { kind: "device", device } : { kind: "browser", device: null };
}

/**
 * Clipboard content is more private than telemetry, so reads need the same proof as writes:
 * with SPARKDASH_TOKEN set every request must carry it (loopback GETs included), and a
 * non-loopback bind without a token never serves the clipboard.
 */
export function clipboardAccess(req, { bindHost } = {}) {
  const host = bindHost ?? process.env.BIND_HOST ?? "127.0.0.1";
  if (configuredToken()) {
    const auth = authenticate(req);
    return auth.ok ? null : { status: auth.status, error: auth.error };
  }
  if (requireRemoteAuth(host)) return { status: 403, error: "The shared clipboard on a non-loopback bind requires SPARKDASH_TOKEN" };
  return null;
}

function readText(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.pause();
        reject(new ClipboardError(413, `text is over ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function contentDisposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Register /api/clipboard/*. Off by default (settings.clipboardEnabled): every route answers
 * 404 while it is off, and nothing is written to disk until the first enabled request. `onChange(revision)` runs after each change so the server can tell open
 * dashboards; it never carries clipboard content.
 */
export function registerClipboardRoutes(app, opts = {}) {
  const getSettings = opts.getSettings ?? (() => ({}));
  const allow = typeof opts.allow === "function" ? opts.allow : () => true;
  const keyOf = typeof opts.principalKey === "function" ? opts.principalKey : () => "all";
  const access = opts.access ?? clipboardAccess;
  const waiters = new Set();
  let store = null;

  const openStore = () => {
    if (store) return store;
    store = opts.store ?? new ClipboardStore({ dir: opts.dir, limits: opts.limits });
    if (typeof opts.onChange === "function") store.onChange(opts.onChange);
    store.onChange((revision) => {
      for (const w of waiters) w.wake(revision);
    });
    return store;
  };

  const gate = (req, res, next) => {
    if (!getSettings().clipboardEnabled) return res.status(404).json({ error: "not found" });
    const denied = access(req);
    if (denied) return res.status(denied.status).json({ error: denied.error });
    if (!allow(keyOf(req))) return res.status(429).json({ error: "Too many clipboard requests; try again shortly" });
    try {
      openStore();
    } catch (err) {
      console.warn(`[clipboard] cannot open the store: ${err.message}`);
      return res.status(503).json({ error: "the clipboard store is unavailable" });
    }
    res.set("Cache-Control", "no-store");
    next();
  };
  const entryId = (req, res, next) => (isClipboardId(req.params.id) ? next() : res.status(404).json({ error: "not found" }));
  const fail = (res, err) => {
    if (!(err instanceof ClipboardError)) {
      console.warn(`[clipboard] ${err?.message || err}`);
      return res.status(500).json({ error: "clipboard request failed" });
    }
    if (err.status === 413 || err.status === 400) res.set("Connection", "close");
    return res.status(err.status).json({ error: err.message });
  };
  const created = (res, out) => res.status(out.duplicate ? 200 : 201).json({ entry: out.entry, revision: store.revision, ...(out.duplicate ? { duplicate: true } : {}) });

  app.get("/api/clipboard", gate, (_req, res) => {
    res.json({ revision: store.revision, latest: store.latest(), limits: store.limits });
  });

  app.get("/api/clipboard/history", gate, (_req, res) => {
    res.json({ revision: store.revision, entries: store.history() });
  });

  /** Long poll for device agents: answers at once when `since` is stale, otherwise on the next change or after `timeoutMs`. */
  app.get("/api/clipboard/changes", gate, (req, res) => {
    const since = Number.parseInt(String(req.query.since ?? ""), 10);
    const asked = Number.parseInt(String(req.query.timeoutMs ?? ""), 10);
    const timeoutMs = Number.isFinite(asked) ? Math.min(Math.max(asked, 0), MAX_WAIT_MS) : MAX_WAIT_MS;
    const answer = () => res.json({ revision: store.revision, latest: store.latest() });
    if (!Number.isFinite(since) || since !== store.revision || timeoutMs === 0) return answer();
    const waiter = {
      wake: () => {
        done();
        answer();
      },
    };
    const timer = setTimeout(waiter.wake, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      waiters.delete(waiter);
    };
    waiters.add(waiter);
    res.on("close", done);
  });

  app.post("/api/clipboard/text", gate, async (req, res) => {
    if (!/^text\//i.test(req.headers["content-type"] || "")) return res.status(415).json({ error: "send the text as text/plain" });
    try {
      const text = await readText(req, store.limits.maxTextBytes);
      created(res, store.setText(text, sourceOf(req)));
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/clipboard/uploads", gate, async (req, res) => {
    let name = String(req.headers["x-clipboard-name"] ?? "");
    try {
      name = decodeURIComponent(name);
    } catch {
      /* keep the raw header */
    }
    const declared = Number.parseInt(String(req.headers["content-length"] ?? ""), 10);
    try {
      const upload = await store.stageUpload(req, { name, mimeType: req.headers["content-type"], declaredSize: declared });
      res.status(201).json({ upload });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/clipboard", gate, (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    try {
      created(res, store.commitUploads(body.uploads, body.type, sourceOf(req)));
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/clipboard", gate, (_req, res) => {
    const removed = store.clear();
    res.json({ removed, revision: store.revision });
  });

  app.get("/api/clipboard/:id", gate, entryId, (req, res) => {
    const entry = store.get(req.params.id);
    if (!entry) return res.status(404).json({ error: "not found" });
    res.json({ entry });
  });

  app.get("/api/clipboard/:id/text", gate, entryId, (req, res) => {
    const text = store.text(req.params.id);
    if (text == null) return res.status(404).json({ error: "not found" });
    res.type("text/plain; charset=utf-8").send(text);
  });

  app.get("/api/clipboard/:id/parts/:partId", gate, entryId, (req, res) => {
    const found = isClipboardId(req.params.partId) ? store.part(req.params.id, req.params.partId) : null;
    if (!found) return res.status(404).json({ error: "not found" });
    const { part, file } = found;
    const inline = req.query.download !== "1" && part.mimeType.startsWith("image/") && part.mimeType !== "image/svg+xml";
    res.set({
      "Content-Type": part.mimeType,
      "Content-Length": String(part.size),
      "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", part.name),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    });
    const stream = fs.createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  });

  app.delete("/api/clipboard/:id", gate, entryId, (req, res) => {
    if (!store.remove(req.params.id)) return res.status(404).json({ error: "not found" });
    res.json({ removed: true, revision: store.revision });
  });

  return { store: () => store };
}
