import test from "node:test";
import assert from "node:assert/strict";
import { eventI18n, healthI18n, responseI18n } from "./messages.js";
import { APPLICATION_TEXT_MAX_LENGTH, applicationTextI18n } from "../../src/shared/applicationText.js";

test("response descriptors preserve original English and unknown diagnostics", () => {
  const raw = "ssh: connect to host 10.0.0.2: timed out\nfull command output";
  const original = { error: raw };
  assert.equal(responseI18n(original), original);
  assert.deepEqual(responseI18n({ ok: false, error: "HTTP 500" }), { ok: false, error: "HTTP 500" });
});

test("response decoration is shallow and leaves nested results untouched", () => {
  const original = { results: [{ error: "Spark not found" }] };
  assert.equal(responseI18n(original), original);
  assert.equal(original.results[0].i18n, undefined);
  const known = responseI18n({ error: "Spark not found" });
  assert.equal(known.error, "Spark not found");
  assert.equal(known.i18n.error.key, "server.error.sparkNotFound");
});

test("recognizer declines oversized input and preserves legacy English fields", () => {
  const raw = "Spark not found" + "x".repeat(APPLICATION_TEXT_MAX_LENGTH);
  assert.equal(applicationTextI18n(raw), undefined);
  const body = responseI18n({ error: raw });
  assert.equal(body.error, raw);
  assert.equal(body.i18n, undefined);
  assert.deepEqual(responseI18n({ message: "legacy application notice" }), { message: "legacy application notice" });
});

test("event descriptors require the complete authored message and leave stored records untouched", () => {
  const event = Object.freeze({ type: "spark.online", sparkName: "Raw <host>", message: "Raw <host> came online" });
  assert.deepEqual(eventI18n(event), { message: { key: "event.sparkOnline", params: { name: "Raw <host>" } } });
  assert.equal(eventI18n({ ...event, message: `${event.message}: extra diagnostic` }), undefined);
  assert.equal(eventI18n({ ...event, type: "future.event" }), undefined);
  assert.equal(event.i18n, undefined);
});

test("health detail parsing is bounded and keeps numeric evidence and raw kernel suffixes", () => {
  const finding = Object.freeze({ id: "thermal", severity: "warn", title: "GPU is running hot", detail: "87°C (warns at 85°C, critical at 90°C).", hint: "raw hint" });
  assert.deepEqual(healthI18n(finding).detail, { key: "health.thermal.detail", params: { temperature: "87", warn: "85", critical: "90" } });
  assert.equal(finding.i18n, undefined);
  assert.equal(healthI18n({ ...finding, detail: `${finding.detail} extra` }).detail, undefined);
  assert.equal(healthI18n({ ...finding, detail: "x".repeat(APPLICATION_TEXT_MAX_LENGTH + 1) }).detail, undefined);
  const kernel = healthI18n({ id: "xid", severity: "critical", detail: "A GPU or driver error was logged by the kernel within the last hour (3 since boot). Latest: Xid 79 <raw>." });
  assert.deepEqual(kernel.detail?.params, { count: "3", last: "Xid 79 <raw>" });
});
