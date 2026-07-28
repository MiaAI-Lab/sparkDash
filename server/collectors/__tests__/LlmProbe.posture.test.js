/**
 * Unit tests for LLM endpoint security posture (#17).
 * Run: npm test
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { classifyHostScope } from "../../validate.js";
import { LlmProbe } from "../LlmProbe.js";

test("classifyHostScope: loopback / localhost → local", () => {
  assert.equal(classifyHostScope("127.0.0.1"), "local");
  assert.equal(classifyHostScope("127.0.0.2"), "local");
  assert.equal(classifyHostScope("localhost"), "local");
  assert.equal(classifyHostScope("::1"), "local");
});

test("classifyHostScope: RFC1918 + link-local → lan", () => {
  assert.equal(classifyHostScope("10.0.0.5"), "lan");
  assert.equal(classifyHostScope("172.16.1.1"), "lan");
  assert.equal(classifyHostScope("172.31.255.1"), "lan");
  assert.equal(classifyHostScope("192.168.1.10"), "lan");
  assert.equal(classifyHostScope("169.254.1.1"), "lan");
});

test("classifyHostScope: public IPv4 → public", () => {
  assert.equal(classifyHostScope("8.8.8.8"), "public");
  assert.equal(classifyHostScope("1.1.1.1"), "public");
});

test("classifyHostScope: hostname / empty → unknown", () => {
  assert.equal(classifyHostScope("spark.example.com"), "unknown");
  assert.equal(classifyHostScope(""), "unknown");
  assert.equal(classifyHostScope("172.15.0.1"), "public"); // not RFC1918
});

test("_buildPosture: open + public → danger", () => {
  const probe = new LlmProbe({ lanIp: "8.8.8.8" }, 8888);
  probe.authOpen = true;
  const p = probe._buildPosture();
  assert.equal(p.level, "danger");
  assert.equal(p.auth, "open");
  assert.equal(p.scope, "public");
  assert.match(p.label, /Open/);
  assert.match(p.detail, /not the process bind address/);
});

test("_buildPosture: open + lan → warn", () => {
  const probe = new LlmProbe({ lanIp: "192.168.1.50" }, 8888);
  probe.authOpen = true;
  const p = probe._buildPosture();
  assert.equal(p.level, "warn");
  assert.equal(p.scope, "lan");
});

test("_buildPosture: open + local → ok", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe.authOpen = true;
  const p = probe._buildPosture();
  assert.equal(p.level, "ok");
  assert.equal(p.scope, "local");
});

test("_buildPosture: protected → ok regardless of scope", () => {
  const probe = new LlmProbe({ lanIp: "8.8.8.8" }, 8888);
  probe.authOpen = false;
  const p = probe._buildPosture();
  assert.equal(p.level, "ok");
  assert.equal(p.auth, "protected");
  assert.equal(p.label, "Auth required");
});

test("_buildPosture: unknown auth → null", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
  assert.equal(probe._buildPosture(), null);
});

test("_getSnapshot: protected auth marks available false but keeps posture", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
  probe.serverIsOpenAI = true;
  probe.backendType = "vllm";
  probe.authOpen = false;
  const snap = probe._getSnapshot();
  assert.equal(snap.available, false);
  assert.equal(snap.posture.level, "ok");
  assert.equal(snap.posture.auth, "protected");
});
