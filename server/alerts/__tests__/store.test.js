/**
 * alerts.json validation, URL masking, and the masked-URL round trip.
 */
import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultConfig,
  loadAlertsFile,
  maskUrl,
  publicConfig,
  saveAlertsFile,
  validateChannelUrl,
  validateConfig,
} from "../store.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-alerts-store-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const NTFY = "https://ntfy.sh/sparkdash-secret-topic-9f3a";
const DISCORD = "https://discord.com/api/webhooks/123456/abcdefSECRETtoken";

test("maskUrl keeps scheme + host + last 4, never the path or credentials", () => {
  assert.equal(maskUrl(NTFY), "https://ntfy.sh…9f3a");
  assert.equal(maskUrl(DISCORD), "https://discord.com…oken");
  const withCreds = maskUrl("https://user:pa55@hooks.example.com:8443/x/y/zzzz");
  assert.equal(withCreds, "https://hooks.example.com:8443…zzzz");
  assert.ok(!withCreds.includes("pa55"));
});

test("URL validation accepts http(s) only", () => {
  assert.equal(validateChannelUrl(" http://127.0.0.1:5699/hook "), "http://127.0.0.1:5699/hook");
  for (const bad of ["", "ntfy.sh/topic", "ftp://x/y", "javascript:alert(1)", "file:///etc/passwd", "https://"]) {
    assert.throws(() => validateChannelUrl(bad), /URL/, bad);
  }
});

test("validateConfig: channels, rules, repeat interval", () => {
  const cfg = validateConfig({
    repeatIntervalMin: 240,
    rules: { gpu_temperature: { warningC: 80, criticalC: 90, forSec: 60 }, unit_offline: { enabled: false } },
    channels: [{ name: "Phone", type: "ntfy", url: NTFY, minSeverity: "critical" }],
  });
  assert.equal(cfg.repeatIntervalMin, 240);
  assert.deepEqual(cfg.rules.gpu_temperature, { warningC: 80, criticalC: 90, forSec: 60 });
  assert.equal(cfg.channels[0].url, NTFY);
  assert.equal(cfg.channels[0].enabled, true);
  assert.match(cfg.channels[0].id, /^ch_[0-9a-f]{12}$/);

  const bad = [
    [{ rules: { nope: {} } }, /Unknown alert rule/],
    [{ rules: { gpu_temperature: { warningC: 99, criticalC: 90 } } }, /warning must not be above critical/],
    [{ rules: { gpu_temperature: { warningC: 500 } } }, /between/],
    [{ rules: { gpu_temperature: { color: "red" } } }, /unknown setting/],
    [{ rules: { memory_headroom: { unifiedLowGb: 2, unifiedCriticalGb: 4 } } }, /GB10 low/],
    [{ rules: { unit_offline: { enabled: "yes" } } }, /enabled/],
    [{ repeatIntervalMin: 2 }, /at least 5/],
    [{ channels: [{ name: "x", type: "pager", url: NTFY }] }, /type must be/],
    [{ channels: [{ name: "", type: "ntfy", url: NTFY }] }, /name is required/],
    [{ channels: [{ name: "x", type: "ntfy", url: "gopher://x" }] }, /http/],
    [{ channels: [{ name: "x", type: "ntfy", url: NTFY, minSeverity: "info" }] }, /minSeverity/],
  ];
  for (const [body, re] of bad) assert.throws(() => validateConfig(body), re, JSON.stringify(body));
});

test("a PUT that sends back the masked URL keeps the stored one; a new URL replaces it", () => {
  const stored = validateConfig({ channels: [{ name: "Discord", type: "discord", url: DISCORD }] });
  const shown = publicConfig(stored);
  assert.equal(shown.channels[0].url, "https://discord.com…oken");
  assert.ok(!JSON.stringify(shown).includes("SECRET"), "public config never carries the secret");

  // Round trip: the UI sends back exactly what it was shown, with a rename.
  const roundTrip = validateConfig(
    { channels: [{ ...shown.channels[0], name: "Discord #ops" }] },
    stored
  );
  assert.equal(roundTrip.channels[0].url, DISCORD);
  assert.equal(roundTrip.channels[0].name, "Discord #ops");
  assert.equal(roundTrip.channels[0].id, stored.channels[0].id);

  const replaced = validateConfig(
    { channels: [{ id: stored.channels[0].id, name: "Discord", type: "discord", url: "https://discord.com/api/webhooks/9/NEW1" }] },
    stored
  );
  assert.equal(replaced.channels[0].url, "https://discord.com/api/webhooks/9/NEW1");

  // A masked value for a channel the server does not have cannot be resolved.
  assert.throws(
    () => validateConfig({ channels: [{ name: "x", type: "discord", url: "https://discord.com…oken" }] }, stored),
    /masked/
  );
  // Removing a channel: send the list without it.
  assert.equal(validateConfig({ channels: [] }, stored).channels.length, 0);
});

test("alerts.json is written at mode 0600 and reads back", () => {
  const file = path.join(dir, "alerts.json");
  const cfg = validateConfig({ channels: [{ name: "Hook", type: "webhook", url: "http://127.0.0.1:5699/hook" }] });
  saveAlertsFile(file, cfg, { savedAt: 1, firing: [] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const back = loadAlertsFile(file);
  assert.deepEqual(back.config.channels, cfg.channels);
  assert.deepEqual(back.state, { savedAt: 1, firing: [] });
});

test("a missing or corrupt alerts.json falls back to defaults without throwing", () => {
  const silent = { error() {} };
  assert.deepEqual(loadAlertsFile(path.join(dir, "missing.json"), silent).config, defaultConfig());
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{not json");
  assert.deepEqual(loadAlertsFile(bad, silent).config, defaultConfig());
});
