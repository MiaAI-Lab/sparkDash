import test from "node:test";
import assert from "node:assert/strict";
import { energyNodeIds } from "../energy/membership.js";

test("fleet energy membership excludes Raspberry Pi units", () => {
  const registry = {
    sparkIds: ["spark1", "luffy-1", "rtx", "luffy-2"],
    getSpark: (id) => ({ id, kind: id.startsWith("luffy") ? "pi" : id === "rtx" ? "host" : "spark" }),
  };
  assert.deepEqual(energyNodeIds(registry), ["spark1", "rtx"]);
});

test("removing the last Pi does not change the Spark/host membership", () => {
  const registry = {
    sparkIds: ["spark1"],
    getSpark: (id) => ({ id, kind: "spark" }),
  };
  assert.deepEqual(energyNodeIds(registry), ["spark1"]);
});
