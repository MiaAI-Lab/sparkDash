import { test } from "node:test";
import { strict as assert } from "node:assert";
import { llmProbeHost } from "../llmHost.js";

test("llmProbeHost: isLocal → 127.0.0.1 (ds4/start.sh loopback bind)", () => {
  assert.equal(
    llmProbeHost({ isLocal: true, lanIp: "192.168.1.151" }),
    "127.0.0.1"
  );
});

test("llmProbeHost: remote → lanIp", () => {
  assert.equal(
    llmProbeHost({ isLocal: false, lanIp: "192.168.1.143" }),
    "192.168.1.143"
  );
});

test("llmProbeHost: explicit llmHost pins remote HTTP independently of SSH host", () => {
  assert.equal(
    llmProbeHost({ isLocal: false, lanIp: "spark-572d", llmHost: "192.168.1.160" }),
    "192.168.1.160"
  );
});

test("llmProbeHost: missing lanIp → empty string", () => {
  assert.equal(llmProbeHost({ isLocal: false }), "");
  assert.equal(llmProbeHost(null), "");
});

test("llmProbeHost: trimmed override precedes local loopback; blank falls back", () => {
  assert.equal(llmProbeHost({ isLocal: true, llmHost: " 192.168.0.64 " }), "192.168.0.64");
  assert.equal(llmProbeHost({ isLocal: true, llmHost: " " }), "127.0.0.1");
  assert.equal(llmProbeHost({ lanIp: "spark-head", llmHost: " " }), "spark-head");
});
