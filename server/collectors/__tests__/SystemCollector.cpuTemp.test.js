import test from "node:test";
import assert from "node:assert/strict";
import { SystemCollector } from "../SystemCollector.js";

const c = Object.create(SystemCollector.prototype);
const parse = (raw) => c._parseSensorTemp(raw);

test("remote CPU collection returns temperature for DGX Spark nodes", async () => {
  const collector = new SystemCollector({ id: "spark-test", kind: "spark" });
  const result = await collector._getRemoteCpu(async (spark, command) => {
    assert.equal(spark.id, "spark-test");
    assert.match(command, /coretemp\|k10temp\|zenpower\|acpitz/);
    assert.match(command, /thermal_zone\*\/temp/);
    assert.equal((command.match(/echo '---'/g) || []).length, 2);
    return [
      "cpu  100 0 40 860 0 0 0 0",
      "---",
      "CPU architecture: 8",
      "---",
      "70900",
    ].join("\n");
  });

  assert.equal(result.temperature, 70.9);
});

test("converts millidegrees to Celsius", () => {
  assert.equal(parse("70900"), 70.9);
  assert.equal(parse("69200"), 69.2);
});

test("takes the first plausible reading, not the highest", () => {
  assert.equal(parse("70900\n80000\n62200"), 70.9);
});

test("skips the blank line left by the section split", () => {
  assert.equal(parse("\n69200\n66200\n"), 69.2);
});

test("skips unreadable sensors", () => {
  assert.equal(parse("\n\n64500"), 64.5);
  assert.equal(parse("not-a-number\n64500"), 64.5);
});

test("rejects out-of-range values", () => {
  assert.equal(parse("0"), 0);
  assert.equal(parse("-5000"), 0);
  assert.equal(parse("200000"), 0);
  assert.equal(parse("250000"), 0);
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
