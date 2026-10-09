import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GpuHistory, deviceReadings } from "../GpuHistory.js";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gpuhist-")), "h.json");

test("records readings, enforces a minimum gap and returns parallel arrays", () => {
  const h = new GpuHistory({ minGapMs: 1000 });
  assert.equal(h.record("a", 10_000, 50.04, 61, 40), true);
  assert.equal(h.record("a", 10_500, 99, 99, 99), false, "too soon");
  assert.equal(h.record("a", 12_000, 0, 62.26, null), true);
  assert.equal(h.record("a", 11_000, 1, 1, 1), false, "goes back in time");
  assert.deepEqual(h.get("a"), { t: [10_000, 12_000], u: [50, 0], c: [61, 62.3], p: [40, null], gpus: [] });
  assert.deepEqual(h.get("a", 11_000), { t: [12_000], u: [0], c: [62.3], p: [null], gpus: [] });
  assert.deepEqual(h.get("nope"), { t: [], u: [], c: [], p: [], gpus: [] });
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

const card = (index, usage, temperature, draw, limit = 100, name = `Card ${index}`) => ({
  index, name, usage, temperature, power: { draw, limit },
});

test("deviceReadings is vendor-neutral and only reports multi-card hosts", () => {
  assert.deepEqual(deviceReadings(undefined), []);
  assert.deepEqual(deviceReadings([card(0, 1, 2, 3)]), [], "one card is the aggregate");
  const r = deviceReadings([card(0, 10, 50, 25, 100, "Vendor A"), { index: 1, usage: 5, temperature: 40, power: { draw: 5, limit: 0 } }, null]);
  assert.deepEqual(r, [
    { index: 0, name: "Vendor A", usage: 10, temperature: 50, powerPct: 25 },
    { index: 1, name: null, usage: 5, temperature: 40, powerPct: null },
  ]);
});

test("keeps one series per card next to the aggregate, parallel to t", () => {
  const h = new GpuHistory({ minGapMs: 1000 });
  const dev = (a, b) => deviceReadings([card(0, a, 50, 50), card(1, b, 60, 20)]);
  h.record("a", 10_000, 30, 60, 50, dev(10, 30));
  h.record("a", 12_000, 40, 61, 55, dev(20, 40));
  const out = h.get("a");
  assert.deepEqual(out.u, [30, 40]);
  assert.equal(out.gpus.length, 2);
  assert.deepEqual(out.gpus[0], { index: 0, name: "Card 0", u: [10, 20], c: [50, 50], p: [50, 50] });
  assert.deepEqual(out.gpus[1], { index: 1, name: "Card 1", u: [30, 40], c: [60, 60], p: [20, 20] });
  assert.deepEqual(h.get("a", 11_000).gpus[1].u, [40]);
});

test("a single-GPU host and an unknown Spark return an empty gpus list", () => {
  const h = new GpuHistory();
  h.record("a", 10_000, 1, 1, 1);
  h.record("b", 10_000, 1, 1, 1, deviceReadings([card(0, 1, 1, 1)]));
  assert.deepEqual(h.get("a").gpus, []);
  assert.deepEqual(h.get("b").gpus, []);
  assert.deepEqual(h.get("nope"), { t: [], u: [], c: [], p: [], gpus: [] });
});

test("a card that appears later is padded with nulls and the aggregate is untouched", () => {
  const h = new GpuHistory({ minGapMs: 1000 });
  h.record("a", 10_000, 30, 60, 50);
  h.record("a", 12_000, 31, 61, 50);
  h.record("a", 14_000, 32, 62, 50, deviceReadings([card(0, 5, 50, 10), card(1, 7, 55, 20)]));
  const out = h.get("a");
  assert.deepEqual(out.u, [30, 31, 32]);
  assert.deepEqual(out.gpus.map((g) => g.u), [[null, null, 5], [null, null, 7]]);
});

test("a card that disappears gets nulls, and is dropped once it ages out of the window", () => {
  let now = 0;
  const h = new GpuHistory({ maxAgeMs: 10 * 60_000, minGapMs: 1000, now: () => now });
  h.record("a", 0, 1, 1, 1, deviceReadings([card(0, 5, 50, 10), card(1, 7, 55, 20)]));
  h.record("a", 2000, 2, 2, 1, [{ index: 0, usage: 6, temperature: 50, powerPct: 10 }]);
  h.record("a", 4000, 3, 3, 1);
  let out = h.get("a");
  assert.deepEqual(out.u, [1, 2, 3], "aggregate keeps going");
  assert.deepEqual(out.gpus.find((g) => g.index === 1).u, [7, null, null]);
  assert.deepEqual(out.gpus.find((g) => g.index === 0).u, [5, 6, null]);
  // Much later: only a card-0 reading remains in the window, card 1 has aged out.
  now = 60 * 60_000;
  h.record("a", now, 9, 9, 9, deviceReadings([card(0, 8, 50, 10), card(2, 1, 40, 5)]));
  h._prune(now);
  out = h.get("a");
  assert.deepEqual(out.t, [now]);
  assert.deepEqual(out.gpus.map((g) => g.index), [0, 2]);
});

test("per-card memory is bounded like the aggregate", () => {
  let now = 0;
  const h = new GpuHistory({ maxAgeMs: 10 * 60_000, minGapMs: 1000, now: () => now });
  for (let i = 0; i < 1000; i++) {
    now = i * 2000;
    h.record("a", now, 1, 1, 1, deviceReadings([card(0, 1, 1, 1), card(1, 2, 2, 2)]));
  }
  const out = h.get("a");
  assert.ok(out.t.length < 400, "trimmed to about the window");
  for (const g of out.gpus) assert.equal(g.u.length, out.t.length);
  // A bad payload cannot grow the card count without limit.
  for (let i = 0; i < 40; i++) h.record("b", 10_000 + i * 2000, 1, 1, 1, [{ index: i, usage: 1, temperature: 1, powerPct: 1 }]);
  assert.ok(h.get("b").gpus.length <= 16);
});

test("per-card series survive a restart through the file, and old files without them still load", () => {
  const file = tmpFile();
  const now = 1_000_000;
  const a = new GpuHistory({ file, minGapMs: 1, now: () => now });
  a.record("a", now - 4000, 1, 1, 1, deviceReadings([card(0, 5, 50, 10), card(1, 7, 55, 20)]));
  a.record("a", now - 2000, 2, 2, 1, deviceReadings([card(0, 6, 50, 10), card(1, 8, 55, 20)]));
  a.stop();
  const b = new GpuHistory({ file, minGapMs: 1, now: () => now });
  assert.deepEqual(b.get("a").gpus.map((g) => g.u), [[5, 6], [7, 8]]);
  fs.writeFileSync(file, JSON.stringify({ version: 1, sparks: { a: { t: [now - 1000], u: [1], c: [2], p: [3] } } }));
  const c = new GpuHistory({ file, minGapMs: 1, now: () => now });
  assert.deepEqual(c.get("a"), { t: [now - 1000], u: [1], c: [2], p: [3], gpus: [] });
});
