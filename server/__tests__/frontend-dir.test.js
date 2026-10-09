import { test } from "node:test";
import { strict as assert } from "node:assert";
import path from "path";
import { resolveFrontendDir } from "../frontendDir.js";

const has = (...files) => (p) => files.includes(p);

test("host dist wins when it has an index.html", () => {
  const root = "/app";
  const dir = resolveFrontendDir(root, has("/app/dist/index.html", "/app/dist-baked/index.html"));
  assert.equal(dir, path.join(root, "dist"));
});

test("an empty bind-mounted dist falls back to the copy baked into the image", () => {
  assert.equal(resolveFrontendDir("/app", has("/app/dist-baked/index.html")), "/app/dist-baked");
});

test("no build anywhere gives null (the 503 message)", () => {
  assert.equal(resolveFrontendDir("/app", has()), null);
});
