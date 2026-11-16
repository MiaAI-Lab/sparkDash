import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { clipboardAccess, registerClipboardRoutes } from "../routes.js";
import { ClipboardStore } from "../store.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c40000000049454e44ae426082", "hex");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-clipboard-"));
}

async function startApp({ enabled = true, limits, access = () => null } = {}) {
  const root = tempDir();
  const dir = path.join(root, "clipboard");
  const settings = { clipboardEnabled: enabled };
  const changes = [];
  const app = express();
  app.use(express.json());
  const handle = registerClipboardRoutes(app, { getSettings: () => settings, dir, limits, access, onChange: (r) => changes.push(r) });
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/clipboard`;
  return {
    base,
    dir,
    settings,
    changes,
    handle,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => {
          fs.rmSync(root, { recursive: true, force: true });
          r();
        });
      }),
  };
}

const postText = (base, text, headers = {}) => fetch(`${base}/text`, { method: "POST", headers: { "Content-Type": "text/plain; charset=utf-8", ...headers }, body: text });
const upload = (base, body, name, type) => fetch(`${base}/uploads`, { method: "POST", headers: { "Content-Type": type, "X-Clipboard-Name": encodeURIComponent(name) }, body });
const commit = (base, uploads, type) => fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uploads, ...(type ? { type } : {}) }) });

test("while clipboardEnabled is off every route is 404 and nothing is written to disk", async () => {
  const a = await startApp({ enabled: false });
  for (const [method, p] of [["GET", ""], ["GET", "/history"], ["GET", "/changes"], ["DELETE", ""], ["POST", "/uploads"]]) {
    assert.equal((await fetch(a.base + p, { method })).status, 404, `${method} ${p}`);
  }
  assert.equal((await postText(a.base, "secret")).status, 404);
  assert.equal(fs.existsSync(a.dir), false);
  await a.close();
});

test("text: latest, history newest first, full text, device source, duplicates of the latest are not re-added", async () => {
  const a = await startApp();
  assert.deepEqual((await (await fetch(a.base)).json()).latest, null);
  const r1 = await postText(a.base, "hello", { "X-Clipboard-Device": "desk-01" });
  assert.equal(r1.status, 201);
  const e1 = (await r1.json()).entry;
  assert.equal(e1.type, "text");
  assert.equal(e1.textPreview, "hello");
  assert.deepEqual(e1.source, { kind: "device", device: "desk-01" });

  const long = "ü".repeat(5000);
  const e2 = (await (await postText(a.base, long, { "X-Clipboard-Device": "bad name!" })).json()).entry;
  assert.equal(e2.textTruncated, true);
  assert.equal(e2.textPreview.length, 4000);
  assert.equal(e2.textSize, Buffer.byteLength(long));
  assert.deepEqual(e2.source, { kind: "browser", device: null });
  assert.equal(await (await fetch(`${a.base}/${e2.id}/text`)).text(), long);

  const dup = await postText(a.base, long);
  assert.equal(dup.status, 200);
  assert.equal((await dup.json()).duplicate, true);

  const hist = await (await fetch(`${a.base}/history`)).json();
  assert.deepEqual(hist.entries.map((e) => e.id), [e2.id, e1.id]);
  assert.equal(hist.revision, 2);
  assert.deepEqual(a.changes, [1, 2]);
  assert.equal((await fetch(a.base)).headers.get("cache-control"), "no-store");
  await a.close();
});

test("history keeps the newest ten and drops the content of older entries", async () => {
  const a = await startApp();
  for (let i = 0; i < 12; i++) await postText(a.base, `copy ${i}`);
  const { entries } = await (await fetch(`${a.base}/history`)).json();
  assert.equal(entries.length, 10);
  assert.equal(entries[0].textPreview, "copy 11");
  assert.equal(entries[9].textPreview, "copy 2");
  assert.equal(fs.readdirSync(path.join(a.dir, "blobs")).length, 10);
  await a.close();
});

test("an uploaded image becomes an image entry served inline; several uploads become a files entry", async () => {
  const a = await startApp();
  const up = await upload(a.base, PNG, "shot.png", "image/png");
  assert.equal(up.status, 201);
  const { upload: u } = await up.json();
  assert.equal(u.size, PNG.length);
  const img = await commit(a.base, [u.id]);
  assert.equal(img.status, 201);
  const entry = (await img.json()).entry;
  assert.equal(entry.type, "image");
  const part = await fetch(`${a.base}/${entry.id}/parts/${entry.parts[0].id}`);
  assert.equal(part.headers.get("content-type"), "image/png");
  assert.match(part.headers.get("content-disposition"), /^inline; filename="shot.png"/);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), PNG);
  const dl = await fetch(`${a.base}/${entry.id}/parts/${entry.parts[0].id}?download=1`);
  assert.match(dl.headers.get("content-disposition"), /^attachment;/);
  await dl.arrayBuffer();

  const f1 = (await (await upload(a.base, "a,b\n", "data.csv", "text/csv")).json()).upload;
  const f2 = (await (await upload(a.base, "<svg/>", "../../evil.svg", "image/svg+xml")).json()).upload;
  assert.equal(f2.name, ".._.._evil.svg");
  const files = (await (await commit(a.base, [f1.id, f2.id])).json()).entry;
  assert.equal(files.type, "files");
  assert.equal(files.size, 4 + 6);
  const svg = await fetch(`${a.base}/${files.id}/parts/${files.parts[1].id}`);
  assert.match(svg.headers.get("content-disposition"), /^attachment;/);
  assert.equal(svg.headers.get("content-security-policy"), "sandbox");
  await svg.text();

  assert.equal((await commit(a.base, [f1.id])).status, 400, "an upload is claimed once");
  assert.equal((await commit(a.base, [(await (await upload(a.base, "x", "x.txt", "text/plain")).json()).upload.id], "image")).status, 400);
  await a.close();
});

test("files with the same bytes under other names are a new copy; the same files again are a duplicate", async () => {
  const a = await startApp();
  const stage = async (name) => (await (await upload(a.base, "x", name, "text/plain")).json()).upload.id;
  const first = await commit(a.base, [await stage("a.txt"), await stage("b.txt")]);
  assert.equal(first.status, 201);
  const renamed = await commit(a.base, [await stage("a.txt"), await stage("c.txt")]);
  assert.equal(renamed.status, 201);
  assert.deepEqual((await renamed.json()).entry.parts.map((p) => p.name), ["a.txt", "c.txt"]);
  const again = await commit(a.base, [await stage("a.txt"), await stage("c.txt")]);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).duplicate, true);
  await a.close();
});

test("text, files and entries over the limits are refused with 413", async () => {
  const a = await startApp({ limits: { maxTextBytes: 8, maxPartBytes: 16, maxEntryBytes: 20, maxParts: 2 } });
  assert.equal((await postText(a.base, "123456789")).status, 413);
  assert.equal((await upload(a.base, Buffer.alloc(17), "big.bin", "application/octet-stream")).status, 413);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await (await upload(a.base, Buffer.alloc(12, i), `f${i}`, "application/octet-stream")).json()).upload.id);
  assert.equal((await commit(a.base, ids)).status, 413);
  assert.equal((await commit(a.base, ids.slice(0, 2))).status, 413);
  assert.equal((await fetch(`${a.base}/text`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 415);
  assert.equal((await (await fetch(`${a.base}/history`)).json()).entries.length, 0);
  await a.close();
});

test("delete one entry and clear all bump the revision and free the content", async () => {
  const a = await startApp();
  const e1 = (await (await postText(a.base, "one")).json()).entry;
  await postText(a.base, "two");
  const del = await fetch(`${a.base}/${e1.id}`, { method: "DELETE" });
  assert.deepEqual(await del.json(), { removed: true, revision: 3 });
  assert.equal((await fetch(`${a.base}/${e1.id}`, { method: "DELETE" })).status, 404);
  assert.equal((await fetch(`${a.base}/not-an-id`)).status, 404);
  assert.deepEqual(await (await fetch(a.base, { method: "DELETE" })).json(), { removed: 1, revision: 4 });
  assert.equal(fs.readdirSync(path.join(a.dir, "blobs")).length, 0);
  await a.close();
});

test("the changes long poll answers at once when stale and otherwise on the next change", async () => {
  const a = await startApp();
  const stale = await (await fetch(`${a.base}/changes?since=-1`)).json();
  assert.equal(stale.revision, 0);
  const t0 = Date.now();
  const pending = fetch(`${a.base}/changes?since=0&timeoutMs=5000`).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 100));
  await postText(a.base, "wake");
  const woke = await pending;
  assert.equal(woke.revision, 1);
  assert.equal(woke.latest.textPreview, "wake");
  assert.ok(Date.now() - t0 < 4000);
  const idle = await (await fetch(`${a.base}/changes?since=1&timeoutMs=50`)).json();
  assert.equal(idle.revision, 1);
  await a.close();
});

test("entries and the revision survive a restart; unreadable records are dropped", () => {
  const dir = path.join(tempDir(), "clipboard");
  const s1 = new ClipboardStore({ dir });
  s1.setText("kept", { kind: "browser", device: null });
  s1.close();
  const index = JSON.parse(fs.readFileSync(path.join(dir, "entries.json"), "utf8"));
  index.entries.push({ id: "00000000-0000-0000-0000-000000000000", type: "text", textSha256: "f".repeat(64), parts: [], source: {}, createdAt: 1 });
  fs.writeFileSync(path.join(dir, "entries.json"), JSON.stringify(index));
  const s2 = new ClipboardStore({ dir });
  assert.equal(s2.revision, 1);
  assert.deepEqual(s2.history().map((e) => e.textPreview), ["kept"]);
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test("access: a configured token is required for reads too; a remote bind without one is refused", () => {
  const saved = process.env.SPARKDASH_TOKEN;
  try {
    delete process.env.SPARKDASH_TOKEN;
    assert.equal(clipboardAccess({ headers: {} }, { bindHost: "127.0.0.1" }), null);
    assert.equal(clipboardAccess({ headers: {} }, { bindHost: "0.0.0.0" }).status, 403);
    process.env.SPARKDASH_TOKEN = "clipboard-test-token";
    assert.equal(clipboardAccess({ method: "GET", headers: {} }, { bindHost: "127.0.0.1" }).status, 401);
    assert.equal(clipboardAccess({ headers: { authorization: "Bearer clipboard-test-token" } }, { bindHost: "0.0.0.0" }), null);
  } finally {
    if (saved === undefined) delete process.env.SPARKDASH_TOKEN;
    else process.env.SPARKDASH_TOKEN = saved;
  }
});
