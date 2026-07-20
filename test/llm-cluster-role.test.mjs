import test from "node:test";
import assert from "node:assert/strict";
import { SparkMonitor } from "../server/sparks/SparkMonitor.js";

function spark(llmCluster) {
  return {
    id: "spark-02",
    name: "Spark 02",
    lanIp: "192.168.1.202",
    isLocal: false,
    ssh: { host: "192.168.1.202", user: "admin", auth: "key" },
    llmPorts: [8888],
    llmCluster,
  };
}

test("worker cluster metadata is exposed in the Spark snapshot", () => {
  const llmCluster = {
    label: "GLM-5.2",
    role: "worker",
    headSparkId: "spark-01",
    headPort: 8210,
    rank: 1,
    worldSize: 4,
  };

  const snapshot = new SparkMonitor(spark(llmCluster)).snapshot();
  assert.deepEqual(snapshot.llmCluster, llmCluster);
});

test("head cluster metadata is exposed in the Spark snapshot", () => {
  const llmCluster = {
    label: "DeepSeek V4 Flash",
    role: "head",
    headSparkId: "spark-05",
    headPort: 8888,
    rank: 0,
    worldSize: 2,
  };

  const snapshot = new SparkMonitor(spark(llmCluster)).snapshot();
  assert.deepEqual(snapshot.llmCluster, llmCluster);
});

test("Sparks without cluster metadata remain unassigned", () => {
  const snapshot = new SparkMonitor(spark(undefined)).snapshot();
  assert.equal(snapshot.llmCluster, null);
});
