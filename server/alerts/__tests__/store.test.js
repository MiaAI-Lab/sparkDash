/**
 * alerts.json and channel validation: the outbound policy at save time, masked
 * URLs, no URL ever written to alerts.json, files from the earlier build.
 */
import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, loadAlertsFile, maskUrl, publicConfig, saveAlertsFile, validateChannelUrl, validateConfig } from "../store.js";
import { quietLog } from "./fixtures.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-alerts-store-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("channel URLs get validate.js's outbound policy: LAN and loopback allowed, metadata/link-local/multicast refused", () => {
  for (const ok of ["https://ntfy.sh/topic", "http://192.168.1.50:8080/alerts", "http://10.0.0.2/x", "http://100.100.1.2/x", "http://127.0.0.1:5698/hook", "http://ntfy.lan/t", "https://[2001:db8::1]/x"]) {
    assert.doesNotThrow(() => validateChannelUrl(ok), ok);
  }
  for (const bad of ["http://169.254.169.254/latest/meta-data", "http://0.0.0.0/x", "http://224.0.0.1/x", "http://[fe80::1]/x", "http://[::ffff:169.254.169.254]/x", "http://[::]/x"]) {
    assert.throws(() => validateChannelUrl(bad), /not allowed/, bad);
  }
  assert.throws(() => validateChannelUrl("ftp://x/y"), /http:\/\/ or https:\/\//);
  assert.throws(() => validateChannelUrl("file:///etc/passwd"), /http:\/\/ or https:\/\//);
  assert.throws(() => validateChannelUrl("not a url"), /not a valid URL/);
  assert.throws(() => validateChannelUrl(""), /required/);
});

test("rules take only enabled and forSec; thresholds are not ours to set", () => {
  const next = validateConfig({ rules: { thermal: { enabled: false, forSec: 30 } } });
  assert.deepEqual(next.rules, { thermal: { enabled: false, forSec: 30 } });
  assert.throws(() => validateConfig({ rules: { thermal: { warningC: 70 } } }), /unknown setting warningC/);
  assert.throws(() => validateConfig({ rules: { gpu_throttle: { enabled: true } } }), /Unknown alert rule/);
  assert.throws(() => validateConfig({ rules: { thermal: { forSec: -1 } } }), /between/);
});

test("the API masks URLs and a masked URL sent back keeps the stored one", () => {
  const url = "https://ntfy.example.com/sparkdash-secret-topic";
  const cfg = validateConfig({ channels: [{ name: "Phone", type: "ntfy", url }] });
  const pub = publicConfig(cfg);
  assert.equal(pub.channels[0].url, maskUrl(url));
  assert.equal(pub.channels[0].hasUrl, true);
  assert.ok(!JSON.stringify(pub).includes("secret-topic"));
  const again = validateConfig({ channels: [{ ...pub.channels[0] }] }, cfg);
  assert.equal(again.channels[0].url, url);
  assert.throws(() => validateConfig({ channels: [{ name: "New", type: "ntfy", url: pub.channels[0].url }] }, cfg), /masked/);
});

test("alerts.json never holds a URL", () => {
  const file = path.join(dir, "alerts.json");
  const cfg = validateConfig({ channels: [{ name: "Phone", type: "ntfy", url: "https://ntfy.example.com/secret-topic" }] });
  saveAlertsFile(file, cfg, null);
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes("secret-topic"));
  assert.ok(!raw.includes("\"url\""));
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
  const loaded = loadAlertsFile(file, quietLog);
  assert.equal(loaded.config.channels[0].name, "Phone");
  assert.equal(loaded.config.channels[0].url, "");
  assert.equal(loaded.legacyUrls.size, 0);
});

test("a file from the earlier build loads: plaintext URLs come back as legacyUrls, unknown rules are dropped", () => {
  const file = path.join(dir, "legacy.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      repeatIntervalMin: 60,
      rules: { gpu_throttle: { enabled: true }, memory_headroom: { unifiedLowGb: 8 }, unit_offline: { forSec: 30 } },
      channels: [
        { id: "ch_1", name: "Phone", type: "ntfy", url: "https://ntfy.example.com/old-topic", enabled: true, minSeverity: "warning" },
        { id: "ch_2", name: "Bad", type: "webhook", url: "http://169.254.169.254/x", enabled: true, minSeverity: "critical" },
      ],
      state: null,
    })
  );
  const { config, legacyUrls } = loadAlertsFile(file, quietLog);
  assert.equal(config.repeatIntervalMin, 60);
  assert.deepEqual(config.rules, {});
  assert.deepEqual(config.channels.map((c) => c.id), ["ch_1", "ch_2"]);
  assert.equal(legacyUrls.get("ch_1"), "https://ntfy.example.com/old-topic");
  assert.equal(legacyUrls.has("ch_2"), false, "a URL the policy refuses is not carried over");
});

test("a corrupt file is treated as fresh", () => {
  const file = path.join(dir, "corrupt.json");
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(loadAlertsFile(file, quietLog).config, defaultConfig());
});
