import { test } from "node:test";
import { strict as assert } from "node:assert";
import { formatLlmBaseUrl, parseLlmTargetInput } from "../../../src/shared/llmTarget.js";

test("parseLlmTargetInput: Tailscale HTTPS URL", () => {
  const t = parseLlmTargetInput(
    "https://promaxgb10-bc60.tail96824a.ts.net/v1/models"
  );
  assert.deepEqual(t, {
    host: "promaxgb10-bc60.tail96824a.ts.net",
    port: 443,
    tls: true,
  });
  assert.equal(
    formatLlmBaseUrl(t),
    "https://promaxgb10-bc60.tail96824a.ts.net"
  );
});

test("parseLlmTargetInput: host + port + tls fields", () => {
  const t = parseLlmTargetInput("promaxgb10-bc60.tail96824a.ts.net", 443, true);
  assert.equal(t.host, "promaxgb10-bc60.tail96824a.ts.net");
  assert.equal(t.port, 443);
  assert.equal(t.tls, true);
});

test("parseLlmTargetInput: host:port without scheme", () => {
  const t = parseLlmTargetInput("192.168.1.143:8888", null, false);
  assert.deepEqual(t, { host: "192.168.1.143", port: 8888, tls: false });
  assert.equal(formatLlmBaseUrl(t), "http://192.168.1.143:8888");
});

test("parseLlmTargetInput: empty host throws", () => {
  assert.throws(() => parseLlmTargetInput("  "), /Enter a host/);
});

test("formatLlmBaseUrl omits default ports", () => {
  assert.equal(
    formatLlmBaseUrl({ host: "ex.ts.net", port: 443, tls: true }),
    "https://ex.ts.net"
  );
  assert.equal(
    formatLlmBaseUrl({ host: "ex.ts.net", port: 8443, tls: true }),
    "https://ex.ts.net:8443"
  );
});
