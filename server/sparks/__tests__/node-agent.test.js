import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-node-agent-"));
process.env.SPARKS_JSON_PATH = path.join(tmp, "sparks.json");
process.env.SPARKS_SECRETS_PATH = path.join(tmp, "sparks-secrets.json");
process.env.SECRETS_KEY_PATH = path.join(tmp, ".secrets-key");
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { SparkRegistry } = await import("../SparkRegistry.js");
const { SparkMonitor } = await import("../SparkMonitor.js");
const { NodeAgentCollector } = await import("../../collectors/NodeAgentCollector.js");

const AGENT = { url: "http://192.0.2.10:9110" };

function registryWith(sparks) {
  fs.writeFileSync(process.env.SPARKS_JSON_PATH, JSON.stringify({ sparks }));
  fs.rmSync(process.env.SPARKS_SECRETS_PATH, { force: true });
  return new SparkRegistry();
}

test("the node agent endpoint is read from sparks.json and never set through the API", () => {
  const r = registryWith([
    { id: "a", lanIp: "192.0.2.10", agent: { url: "http://192.0.2.10:9110/" } },
    { id: "local", lanIp: "127.0.0.1", isLocal: true, agent: AGENT },
  ]);
  assert.deepEqual(r.getSpark("a").agent, AGENT);
  assert.equal(r.getSpark("local").agent, null);

  r.updateSpark("a", { name: "renamed", agent: { url: "http://198.51.100.7:9110" } });
  assert.deepEqual(r.getSpark("a").agent, AGENT);
  r.updateSpark("a", { agent: null });
  assert.deepEqual(r.getSpark("a").agent, AGENT);

  r.addSpark({ id: "b", lanIp: "192.0.2.11", agent: { url: "http://198.51.100.7:9110" } });
  assert.equal(r.getSpark("b").agent, null);

  r.addSpark({ id: "m", kind: "mac", lanIp: "192.0.2.12", agent: { port: 8790 } });
  assert.equal(r.getSpark("m").agent.port, 8790);
});

test("an unreachable agent takes the unit offline with the agent's reason, without SSH", async () => {
  const monitor = new SparkMonitor({
    id: "a",
    name: "A",
    kind: "spark",
    platform: "linux",
    lanIp: "192.0.2.10",
    isLocal: false,
    agent: AGENT,
    ssh: { user: "user", host: "192.0.2.10", auth: "key", port: 22 },
    llmMonitoring: false,
  });
  assert.ok(monitor.collector instanceof NodeAgentCollector);
  assert.equal(monitor._residentModelsEnabled({ ...monitor.spark, llmMonitoring: true }), false);
  monitor.collector.agent = {
    snapshot: async () => {
      throw new Error("node agent http://192.0.2.10:9110: ECONNREFUSED");
    },
  };
  monitor._running = true;
  monitor.lastOnlineOk = 0;
  await monitor._checkOnline();
  monitor._running = false;
  assert.equal(monitor.online, false);
  assert.equal(monitor.offlineReason, "node agent: connection refused");
});
