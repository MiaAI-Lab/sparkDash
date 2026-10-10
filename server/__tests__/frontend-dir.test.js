import { test } from "node:test";
import { strict as assert } from "node:assert";
import path from "path";
import { resolveFrontendDir } from "../frontendDir.js";

const has = (...files) => (p) => files.includes(p);

const mtimes = (map) => (p) => map[p];

test("host dist wins when it has an index.html and is not older than the baked copy", () => {
  const root = "/app";
  const both = has("/app/dist/index.html", "/app/dist-baked/index.html");
  assert.equal(resolveFrontendDir(root, both, mtimes({ "/app/dist/index.html": 200, "/app/dist-baked/index.html": 100 })), path.join(root, "dist"));
  assert.equal(resolveFrontendDir(root, both, mtimes({ "/app/dist/index.html": 100, "/app/dist-baked/index.html": 100 })), path.join(root, "dist"));
});

test("a rebuilt image's copy beats an older host build", () => {
  const both = has("/app/dist/index.html", "/app/dist-baked/index.html");
  const dir = resolveFrontendDir("/app", both, mtimes({ "/app/dist/index.html": 100, "/app/dist-baked/index.html": 200 }));
  assert.equal(dir, "/app/dist-baked");
});

test("an unreadable mtime falls back to the host build", () => {
  const both = has("/app/dist/index.html", "/app/dist-baked/index.html");
  assert.equal(resolveFrontendDir("/app", both, () => { throw new Error("EACCES"); }), "/app/dist");
});

test("an empty bind-mounted dist falls back to the copy baked into the image", () => {
  assert.equal(resolveFrontendDir("/app", has("/app/dist-baked/index.html")), "/app/dist-baked");
});

test("no build anywhere gives null (the 503 message)", () => {
  assert.equal(resolveFrontendDir("/app", has()), null);
});
