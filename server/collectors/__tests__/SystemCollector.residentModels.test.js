import { test } from "node:test";
import { strict as assert } from "node:assert";
import { SystemCollector } from "../SystemCollector.js";

const remote = { id: "test", isLocal: false, platform: "linux" };

test("resident models preserves model/container identity from private endpoints", async () => {
  const expected = [
    { modelId: "org/first", container: "primary-vllm" },
    { modelId: "org/second", container: "private-vllm" },
  ];
  const actual = await new SystemCollector(remote).collectResidentModels(async (spark, command) => {
    assert.equal(spark.id, "test");
    assert.ok(command.includes("/v1/models"));
    assert.ok(command.includes("ProxyHandler({})"));
    return JSON.stringify([...expected, { modelId: 42, container: "invalid" }]);
  });
  assert.deepEqual(actual, expected);
});

test("resident discovery degrades safely on missing tools, malformed output or SSH failure", async () => {
  const c = new SystemCollector(remote);
  for (const result of ["[]", "not json", "{}", "null"]) {
    assert.deepEqual(await c.collectResidentModels(async () => result), []);
  }
  assert.deepEqual(await c.collectResidentModels(async () => { throw new Error("SSH unavailable"); }), []);
});

test("resident discovery does not execute Linux commands on unsupported units", async () => {
  for (const config of [{ isLocal: true }, { platform: "windows" }, { platform: "darwin" }]) {
    const c = new SystemCollector({ ...remote, ...config });
    assert.deepEqual(await c.collectResidentModels(async () => assert.fail("must not execute")), []);
  }
});
