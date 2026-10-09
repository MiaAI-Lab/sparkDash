import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GpuHistory } from "../GpuHistory.js";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gpuhist-")), "h.json");

test("records readings, enforces a minimum gap and returns parallel arrays", () => {
  const h = new GpuHistory({ minGapMs: 1000 });
  assert.equal(h.record("a", 10_000, 50.04, 61, 40), true);
  assert.equal(h.record("a", 10_500, 99, 99, 99), false, "too soon");
  assert.equal(h.record("a", 12_000, 0, 62.26, null), true);
  assert.equal(h.record("a", 11_000, 1, 1, 1), false, "goes back in time");
  assert.deepEqual(h.get("a"), { t: [10_000, 12_000], u: [50, 0], c: [61, 62.3], p: [40, null] });
  assert.deepEqual(h.get("a", 11_000), { t: [12_000], u: [0], c: [62.3], p: [null] });
  assert.deepEqual(h.get("nope"), { t: [], u: [], c: [], p: [] });
});

test("rejects non-finite readings", () => {
  const h = new GpuHistory();
  assert.equal(h.record("a", Date.now(), NaN, 50, 1), false);
  assert.equal(h.record("a", Date.now(), 5, undefined, 1), false);
});

test("old readings are trimmed away", () => {
  let now = 0;
  const h = new GpuHistory({ maxAgeMs: 10 * 60_000, minGapMs: 1000, now: () => now });
  for (let i = 0; i < 400; i++) h.record("a", i * 2000, 1, 1, 1);
  const out = h.get("a");
  assert.ok(out.t[0] >= 400 * 2000 - 10 * 60_000 - 60_000 - 2000, "oldest kept is within the window plus slack");
  assert.equal(out.t.at(-1), 399 * 2000);
});

test("survives a restart through the file, dropping readings past the max age", () => {
  const file = tmpFile();
  let now = 1_000_000;
  const a = new GpuHistory({ file, maxAgeMs: 100_000, minGapMs: 1, now: () => now });
  a.record("a", now - 150_000, 1, 1, 1);
  a.record("a", now - 50_000, 2, 2, 2);
  a.record("b", now - 10_000, 3, 3, null);
  a.flush();
  const b = new GpuHistory({ file, maxAgeMs: 100_000, now: () => now });
  assert.deepEqual(b.get("a").t, [now - 50_000]);
  assert.deepEqual(b.get("b").p, [null]);
});

test("a corrupt or missing file starts empty", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(new GpuHistory({ file }).get("a").t, []);
  assert.deepEqual(new GpuHistory({ file: tmpFile() }).get("a").t, []);
});

test("a corrupt file is moved aside so the next save cannot destroy it", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{not json");
  new GpuHistory({ file });
  assert.equal(fs.existsSync(file), false);
  const dir = path.dirname(file);
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith("h.json.corrupt-")));
});

test("flush prunes series with no samples left in the window", () => {
  const file = tmpFile();
  let now = 1_000_000;
  const h = new GpuHistory({ file, maxAgeMs: 100_000, minGapMs: 1, now: () => now });
  h.record("gone", now, 1, 1, 1);
  now += 500_000;
  h.record("kept", now, 1, 1, 1);
  h.flush();
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(saved.sparks), ["kept"]);
});
