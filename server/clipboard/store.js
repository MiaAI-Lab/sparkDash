import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 10,
  maxTextBytes: 1024 * 1024,
  maxPartBytes: 25 * 1024 * 1024,
  maxParts: 20,
  maxEntryBytes: 50 * 1024 * 1024,
});

export const TEXT_PREVIEW_CHARS = 4000;
export const UPLOAD_TTL_MS = 10 * 60_000;
const MAX_PENDING_UPLOADS = 64;
const MAX_NAME_CHARS = 255;

const SHA256_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[0-9a-f-]{36}$/;

export class ClipboardError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function isClipboardId(value) {
  return typeof value === "string" && ID_RE.test(value);
}

export function sanitizeName(raw) {
  const base = String(raw ?? "")
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_NAME_CHARS);
  return base && base !== "." && base !== ".." ? base : "file";
}

export function sanitizeMimeType(raw) {
  const type = String(raw ?? "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type) && type.length <= 127
    ? type
    : "application/octet-stream";
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function contentKeyOf(type, hashes) {
  return type === "text" ? hashes[0] : sha256(`${type}:${hashes.join(",")}`);
}

function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Public shape of an entry: metadata and a text preview, never a path on disk. */
function publicEntry(rec, text) {
  const isText = rec.type === "text";
  const preview = isText && text != null ? text.slice(0, TEXT_PREVIEW_CHARS) : null;
  return {
    id: rec.id,
    type: rec.type,
    textSize: isText ? rec.textSize : 0,
    textPreview: preview,
    textTruncated: isText && text != null ? text.length > TEXT_PREVIEW_CHARS : false,
    parts: rec.parts.map(({ id, name, mimeType, size, sha256 }) => ({ id, name, mimeType, size, sha256 })),
    size: rec.size,
    contentKey: rec.contentKey,
    source: { ...rec.source },
    createdAt: rec.createdAt,
  };
}

/**
 * Shared clipboard history: the newest `maxEntries` copies of text, an image or files.
 * Content lives in `<dir>/blobs/<sha256>`; `<dir>/entries.json` holds the metadata and a
 * revision that increases on every change. Staged uploads live in `<dir>/uploads` until
 * an entry claims them or they expire.
 */
export class ClipboardStore {
  constructor({ dir, limits = {}, now = Date.now } = {}) {
    if (!dir) throw new Error("ClipboardStore needs a directory");
    this.dir = dir;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.now = now;
    this.blobDir = path.join(dir, "blobs");
    this.uploadDir = path.join(dir, "uploads");
    this.indexFile = path.join(dir, "entries.json");
    this.listeners = new Set();
    this.pending = new Map();
    this.textCache = new Map();
    this.revision = 0;
    this.entries = [];
    this.#load();
  }

  #load() {
    fs.mkdirSync(this.blobDir, { recursive: true, mode: 0o700 });
    fs.rmSync(this.uploadDir, { recursive: true, force: true });
    fs.mkdirSync(this.uploadDir, { recursive: true, mode: 0o700 });
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.indexFile, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") console.warn(`[clipboard] ignoring unreadable ${this.indexFile}: ${err.message}`);
    }
    this.revision = Number.isSafeInteger(parsed?.revision) && parsed.revision >= 0 ? parsed.revision : 0;
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    this.entries = entries.filter((e) => this.#validRecord(e)).slice(0, this.limits.maxEntries);
    this.#collectGarbage();
  }

  #validRecord(e) {
    if (!e || !isClipboardId(e.id) || !["text", "image", "files"].includes(e.type)) return false;
    if (!Array.isArray(e.parts) || !e.source || !Number.isFinite(e.createdAt)) return false;
    const hashes = e.type === "text" ? [e.textSha256] : e.parts.map((p) => p?.sha256);
    if (hashes.length === 0 || !hashes.every((h) => SHA256_RE.test(h ?? ""))) return false;
    return hashes.every((h) => fs.existsSync(path.join(this.blobDir, h)));
  }

  #persist() {
    writeFileAtomic(this.indexFile, JSON.stringify({ revision: this.revision, entries: this.entries }));
  }

  #collectGarbage() {
    const live = new Set();
    for (const e of this.entries) {
      if (e.type === "text") live.add(e.textSha256);
      for (const p of e.parts) live.add(p.sha256);
    }
    for (const name of fs.readdirSync(this.blobDir)) {
      if (!live.has(name)) fs.rmSync(path.join(this.blobDir, name), { force: true });
    }
    for (const key of this.textCache.keys()) if (!live.has(key)) this.textCache.delete(key);
  }

  #changed() {
    this.revision += 1;
    this.#persist();
    this.#collectGarbage();
    for (const fn of this.listeners) {
      try {
        fn(this.revision);
      } catch (err) {
        console.warn(`[clipboard] change listener failed: ${err.message}`);
      }
    }
  }

  #storeBlob(hash, source) {
    const target = path.join(this.blobDir, hash);
    if (fs.existsSync(target)) return;
    if (Buffer.isBuffer(source)) writeFileAtomic(target, source);
    else fs.renameSync(source, target);
  }

  #readText(rec) {
    if (this.textCache.has(rec.textSha256)) return this.textCache.get(rec.textSha256);
    const text = fs.readFileSync(path.join(this.blobDir, rec.textSha256), "utf8");
    if (rec.textSize <= 64 * 1024) this.textCache.set(rec.textSha256, text);
    return text;
  }

  #toPublic(rec) {
    return publicEntry(rec, rec.type === "text" ? this.#readText(rec) : null);
  }

  #add(rec) {
    const latest = this.entries[0];
    if (latest && latest.contentKey === rec.contentKey) return { entry: this.#toPublic(latest), duplicate: true };
    this.entries = [rec, ...this.entries].slice(0, this.limits.maxEntries);
    this.#changed();
    return { entry: this.#toPublic(rec), duplicate: false };
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  latest() {
    return this.entries[0] ? this.#toPublic(this.entries[0]) : null;
  }

  history() {
    return this.entries.map((e) => this.#toPublic(e));
  }

  get(id) {
    const rec = this.entries.find((e) => e.id === id);
    return rec ? this.#toPublic(rec) : null;
  }

  text(id) {
    const rec = this.entries.find((e) => e.id === id && e.type === "text");
    return rec ? this.#readText(rec) : null;
  }

  /** `{ part, file }` for streaming one image or file, or null. */
  part(id, partId) {
    const rec = this.entries.find((e) => e.id === id);
    const part = rec?.parts.find((p) => p.id === partId);
    if (!part) return null;
    return { part: { id: part.id, name: part.name, mimeType: part.mimeType, size: part.size, sha256: part.sha256 }, file: path.join(this.blobDir, part.sha256) };
  }

  setText(text, source) {
    if (typeof text !== "string" || text.length === 0) throw new ClipboardError(400, "text must be a non-empty string");
    const buf = Buffer.from(text, "utf8");
    if (buf.length > this.limits.maxTextBytes) throw new ClipboardError(413, `text is over ${this.limits.maxTextBytes} bytes`);
    const hash = sha256(buf);
    this.#storeBlob(hash, buf);
    return this.#add({
      id: randomUUID(),
      type: "text",
      textSha256: hash,
      textSize: buf.length,
      parts: [],
      size: buf.length,
      contentKey: contentKeyOf("text", [hash]),
      source,
      createdAt: this.now(),
    });
  }

  #expireUploads() {
    const t = this.now();
    for (const [id, up] of this.pending) {
      if (t - up.createdAt > UPLOAD_TTL_MS) {
        fs.rmSync(up.file, { force: true });
        this.pending.delete(id);
      }
    }
  }

  /** Stream one image or file into staging. Resolves to the upload's public record. */
  async stageUpload(stream, { name, mimeType, declaredSize } = {}) {
    this.#expireUploads();
    if (this.pending.size >= MAX_PENDING_UPLOADS) throw new ClipboardError(429, "too many pending uploads; try again shortly");
    const max = this.limits.maxPartBytes;
    if (Number.isFinite(declaredSize) && declaredSize > max) throw new ClipboardError(413, `file is over ${max} bytes`);
    const id = randomUUID();
    const file = path.join(this.uploadDir, id);
    const hash = createHash("sha256");
    let size = 0;
    const out = fs.createWriteStream(file, { mode: 0o600 });
    try {
      await new Promise((resolve, reject) => {
        const fail = (err) => {
          stream.unpipe?.(out);
          out.destroy();
          reject(err);
        };
        stream.on("data", (chunk) => {
          size += chunk.length;
          if (size > max) {
            stream.pause();
            fail(new ClipboardError(413, `file is over ${max} bytes`));
            return;
          }
          hash.update(chunk);
        });
        stream.on("error", fail);
        stream.on("aborted", () => fail(new ClipboardError(400, "upload aborted")));
        out.on("error", fail);
        out.on("finish", resolve);
        stream.pipe(out);
      });
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw err;
    }
    if (size === 0) {
      fs.rmSync(file, { force: true });
      throw new ClipboardError(400, "upload is empty");
    }
    const upload = { id, name: sanitizeName(name), mimeType: sanitizeMimeType(mimeType), size, sha256: hash.digest("hex") };
    this.pending.set(id, { ...upload, file, createdAt: this.now() });
    return upload;
  }

  /** Turn staged uploads into one entry: an image when it is a single image, files otherwise. */
  commitUploads(uploadIds, type, source) {
    this.#expireUploads();
    if (!Array.isArray(uploadIds) || uploadIds.length === 0) throw new ClipboardError(400, "uploads must be a non-empty array");
    if (uploadIds.length > this.limits.maxParts) throw new ClipboardError(413, `at most ${this.limits.maxParts} files per entry`);
    if (new Set(uploadIds).size !== uploadIds.length) throw new ClipboardError(400, "uploads must not repeat");
    const ups = uploadIds.map((id) => (typeof id === "string" ? this.pending.get(id) : undefined));
    if (ups.some((u) => !u)) throw new ClipboardError(400, "unknown or expired upload");
    const total = ups.reduce((n, u) => n + u.size, 0);
    if (total > this.limits.maxEntryBytes) throw new ClipboardError(413, `entry is over ${this.limits.maxEntryBytes} bytes`);
    const singleImage = ups.length === 1 && ups[0].mimeType.startsWith("image/");
    const kind = type ?? (singleImage ? "image" : "files");
    if (kind !== "image" && kind !== "files") throw new ClipboardError(400, "type must be image or files");
    if (kind === "image" && !singleImage) throw new ClipboardError(400, "an image entry is exactly one image");
    const parts = ups.map((u) => {
      this.#storeBlob(u.sha256, u.file);
      fs.rmSync(u.file, { force: true });
      this.pending.delete(u.id);
      return { id: randomUUID(), name: u.name, mimeType: u.mimeType, size: u.size, sha256: u.sha256 };
    });
    return this.#add({
      id: randomUUID(),
      type: kind,
      textSha256: null,
      textSize: 0,
      parts,
      size: total,
      contentKey: contentKeyOf(kind, parts.map((p) => p.sha256)),
      source,
      createdAt: this.now(),
    });
  }

  remove(id) {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === before) return false;
    this.#changed();
    return true;
  }

  clear() {
    const n = this.entries.length;
    if (n === 0) return 0;
    this.entries = [];
    this.#changed();
    return n;
  }

  close() {
    this.listeners.clear();
    for (const up of this.pending.values()) fs.rmSync(up.file, { force: true });
    this.pending.clear();
  }
}
