import test from "node:test";
import assert from "node:assert/strict";
import { SystemCollector } from "../SystemCollector.js";

// The constructor resolves nvidia-smi and seeds rate baselines; _parseSensorTemp is
// pure, so bind it to a bare prototype instead (same approach as role-normalize).
const c = Object.create(SystemCollector.prototype);
const parse = (raw) => c._parseSensorTemp(raw);

test("converts millidegrees to Celsius", () => {
  assert.equal(parse("70900"), 70.9);
  assert.equal(parse("69200"), 69.2);
});

test("takes the first plausible reading, not the highest", () => {
  // Remote command emits hwmon candidates before thermal zones; the first one wins
  // so remote hosts pick the same sensor the local sysfs path does.
  assert.equal(parse("70900\n80000\n62200"), 70.9);
});

test("skips the blank line left by the section split", () => {
  // sshExec output is split on '---', so the temperature section starts with \n.
  assert.equal(parse("\n69200\n66200\n"), 69.2);
});

test("skips unreadable sensors", () => {
  // e.g. mt7925_phy0 exposes temp1_input but reads empty.
  assert.equal(parse("\n\n64500"), 64.5);
  assert.equal(parse("not-a-number\n64500"), 64.5);
});

test("rejects out-of-range values", () => {
  assert.equal(parse("0"), 0);
  assert.equal(parse("-5000"), 0);
  assert.equal(parse("200000"), 0);
  assert.equal(parse("250000"), 0);
  // Out-of-range entries are skipped rather than aborting the scan.
  assert.equal(parse("0\n250000\n70900"), 70.9);
});

test("returns 0 when nothing is reported", () => {
  assert.equal(parse(""), 0);
  assert.equal(parse("\n\n"), 0);
  assert.equal(parse(undefined), 0);
});

test("rounds to one decimal", () => {
  assert.equal(parse("69250"), 69.3);
  assert.equal(parse("69240"), 69.2);
});
