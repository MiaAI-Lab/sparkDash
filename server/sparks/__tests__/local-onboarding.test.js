import test from "node:test";
import assert from "node:assert/strict";
import { validateSparkTarget } from "../../validate.js";
import { SparkRegistry } from "../SparkRegistry.js";

test("local unit accepts a blank LAN IP while remote units remain strict", () => {
  assert.equal(validateSparkTarget({ isLocal: true, lanIp: "", ssh: {} }), null);
  assert.equal(validateSparkTarget({ isLocal: false, lanIp: "", ssh: {} }), "lanIp or ssh.host is required");

  const registry = Object.create(SparkRegistry.prototype);
  const local = registry._normalizeConfig({ id: "local", name: "Local", isLocal: true, lanIp: "", ssh: {} });
  assert.equal(local.lanIp, "");
  assert.equal(local.ssh.host, "");
});
