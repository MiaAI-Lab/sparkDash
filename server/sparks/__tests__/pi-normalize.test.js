import test from "node:test";
import assert from "node:assert/strict";
import { SparkRegistry } from "../SparkRegistry.js";
import { validateSparkTarget } from "../../validate.js";

const normalize = (config) => Object.create(SparkRegistry.prototype)._normalizeConfig(config);

test("Pi units normalize to a standalone Linux unit with no LLM/Comfy surface", () => {
  const spark = normalize({
    id: "luffy-1",
    name: "luffy-1",
    kind: "pi",
    platform: "windows",
    isLocal: true,
    role: "head",
    llmMonitoring: true,
    comfyMonitoring: true,
    cx7Ip: "10.0.0.9",
    macAddress: "aa:bb:cc:dd:ee:ff",
    llmPorts: [8000],
    hermesMonitoring: true,
    tailscaleMonitoring: true,
    ssh: { host: "192.168.1.50", user: "devopsfortunato" },
  });
  assert.equal(spark.kind, "pi");
  assert.equal(spark.platform, "linux");
  assert.equal(spark.isLocal, false);
  assert.equal(spark.role, "standalone");
  assert.equal(spark.workerNode, false);
  assert.equal(spark.llmMonitoring, false);
  assert.equal(spark.comfyMonitoring, false);
  assert.deepEqual(spark.llmPorts, []);
  assert.equal(spark.llmHost, null);
  assert.equal(spark.cx7Ip, null);
  assert.equal(spark.macAddress, null);
  assert.equal(spark.hermesMonitoring, true);
  assert.equal(spark.tailscaleMonitoring, true);
});

test("Pi normalization is idempotent, so an empty llmPorts list survives reload", () => {
  const once = normalize({ id: "pi", kind: "pi", ssh: { host: "192.168.1.50" } });
  const twice = normalize(once);
  assert.deepEqual(twice, once);
  assert.deepEqual(twice.llmPorts, []);
});

test("validating a Pi rejects local mode and non-Linux platforms but accepts a remote target", () => {
  assert.match(validateSparkTarget({ kind: "pi", isLocal: true, lanIp: "192.168.1.50", ssh: {} }), /remote-only/);
  assert.match(validateSparkTarget({ kind: "pi", platform: "windows", lanIp: "192.168.1.50", ssh: {} }), /Linux/);
  assert.equal(validateSparkTarget({ kind: "pi", lanIp: "192.168.1.50", ssh: { user: "devopsfortunato" } }), null);
});

test("Pi units keep a per-unit SSH identity and reject unsafe paths", () => {
  const spark = normalize({
    id: "pi",
    kind: "pi",
    ssh: { host: "192.168.1.50", identityFile: "/root/.ssh/sparkdash_pi" },
  });
  assert.equal(spark.ssh.identityFile, "/root/.ssh/sparkdash_pi");
  assert.equal(normalize({ id: "pi", kind: "pi", ssh: { host: "192.168.1.50", identityFile: "../etc/passwd" } }).ssh.identityFile, null);
  assert.match(
    validateSparkTarget({ kind: "pi", lanIp: "192.168.1.50", ssh: { identityFile: "relative/key" } }),
    /SSH key file/
  );
});

test("Spark and GPU-host normalization still keep their roles and ports", () => {
  const spark = normalize({ id: "s", kind: "spark", role: "head", ssh: { host: "10.0.0.2" } });
  assert.equal(spark.kind, "spark");
  assert.equal(spark.role, "head");
  assert.equal(spark.llmMonitoring, true);
  assert.deepEqual(spark.llmPorts, [8888]);

  const host = normalize({ id: "h", kind: "host", platform: "linux", ssh: { host: "10.0.0.3" } });
  assert.equal(host.kind, "host");
  assert.equal(host.llmMonitoring, true);
});
