import test from "node:test";
import assert from "node:assert/strict";
import { SparkRegistry } from "../SparkRegistry.js";

const r = Object.create(SparkRegistry.prototype);
const n = (partial) =>
  r._normalizeConfig({ id: "u1", name: "U1", lanIp: "10.0.0.9", ...partial });

test("kind mac round-trips through normalization", () => {
  assert.equal(n({ kind: "mac" }).kind, "mac");
});

test("existing kinds are unchanged and unknown kinds default to spark", () => {
  assert.equal(n({ kind: "host" }).kind, "host");
  assert.equal(n({ kind: "spark" }).kind, "spark");
  assert.equal(n({}).kind, "spark");
  assert.equal(n({ kind: "windows" }).kind, "spark");
  assert.equal(n({ kind: "MAC" }).kind, "spark");
});

test("mac agent endpoint normalizes, and only for mac units", () => {
  assert.deepEqual(n({ kind: "mac", agent: { port: "8790" } }).agent, {
    url: null,
    host: null,
    port: 8790,
  });
  assert.deepEqual(
    n({ kind: "mac", agent: { url: " http://mac.tailnet:9000 ", port: 1 } }).agent,
    { url: "http://mac.tailnet:9000", host: null, port: 1 }
  );
  assert.deepEqual(n({ kind: "mac", agent: { host: "10.0.0.9" } }).agent, {
    url: null,
    host: "10.0.0.9",
    port: null,
  });
  // Nothing usable in the block → stay on the SSH transport.
  assert.equal(n({ kind: "mac", agent: {} }).agent, null);
  assert.equal(n({ kind: "mac", agent: { port: 70000 } }).agent, null);
  assert.equal(n({ kind: "mac", agent: { port: "nope" } }).agent, null);
  assert.equal(n({ kind: "mac" }).agent, null);
  // A DGX Spark carrying an agent block ignores it.
  assert.equal(n({ kind: "spark", agent: { port: 8790 } }).agent, null);
});
