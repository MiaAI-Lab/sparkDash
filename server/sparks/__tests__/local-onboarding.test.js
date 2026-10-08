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
  assert.equal(local.ssh.port, 22);

  const custom = registry._normalizeConfig({
    id: "remote",
    name: "Remote",
    lanIp: "192.168.1.20",
    ssh: { port: "2222" },
  });
  assert.equal(custom.ssh.port, 2222);
  const invalid = registry._normalizeConfig({
    id: "remote",
    name: "Remote",
    lanIp: "192.168.1.20",
    ssh: { port: "nope" },
  });
  assert.equal(invalid.ssh.port, 22);
});
