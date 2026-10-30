/**
 * The version read must never be able to stop the server from starting: before it existed
 * nothing read package.json at runtime, so a deployment whose layout hides the manifest
 * used to serve normally and must keep doing so, with the version simply unknown.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readServerVersion } from "../serverVersion.js";

async function tempRoot(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sparkdash-version-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("reads the version from the manifest beside server/", async (t) => {
  const root = await tempRoot(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2.75.4" }));
  assert.equal(readServerVersion(root), "2.75.4");
});

test("a missing manifest is an unknown version, not a throw", async (t) => {
  const root = await tempRoot(t);
  assert.equal(readServerVersion(root), null);
});

test("a malformed manifest is an unknown version, not a throw", async (t) => {
  const root = await tempRoot(t);
  await writeFile(path.join(root, "package.json"), "{ not json");
  assert.equal(readServerVersion(root), null);
});

test("a manifest with no version, or an unusable one, reports unknown", async (t) => {
  const root = await tempRoot(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "sparkdash" }));
  assert.equal(readServerVersion(root), null);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: 2 }));
  assert.equal(readServerVersion(root), null);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "" }));
  assert.equal(readServerVersion(root), null);
});
