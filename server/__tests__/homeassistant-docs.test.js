import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../../", import.meta.url);

function read(name) {
  return fs.readFileSync(new URL(name, root), "utf8");
}

test("README links the Home Assistant install guide", () => {
  const readme = read("README.md");
  assert.ok(readme.includes("## Home Assistant"), "README must document Home Assistant");
  assert.ok(
    readme.includes("[homeassistant/README.md](./homeassistant/README.md)"),
    "README must link the install guide",
  );
  assert.ok(read("homeassistant/README.md").includes("custom_components/sparkdash"));
});

test("sparkDash custom component is a config-flow hub", () => {
  const manifest = JSON.parse(read("homeassistant/custom_components/sparkdash/manifest.json"));
  assert.equal(manifest.domain, "sparkdash");
  assert.equal(manifest.config_flow, true);
  assert.equal(manifest.integration_type, "hub");
  assert.equal(manifest.iot_class, "local_polling");
  for (const name of [
    "homeassistant/custom_components/sparkdash/__init__.py",
    "homeassistant/custom_components/sparkdash/config_flow.py",
    "homeassistant/custom_components/sparkdash/coordinator.py",
    "homeassistant/custom_components/sparkdash/sensor.py",
    "homeassistant/custom_components/sparkdash/binary_sensor.py",
    "homeassistant/custom_components/sparkdash/strings.json",
    "homeassistant/custom_components/sparkdash/translations/en.json",
  ]) {
    assert.ok(read(name).trim().length > 0, `${name} must exist`);
  }
  const strings = read("homeassistant/custom_components/sparkdash/strings.json");
  const english = read("homeassistant/custom_components/sparkdash/translations/en.json");
  assert.equal(strings, english, "custom components load entity names from translations/en.json");
  assert.match(strings, /GPU temperature/);
});

test("the integration tree does not ship a sample LAN address or a token", () => {
  const dir = new URL("homeassistant/", root);
  const files = fs.readdirSync(dir, { recursive: true })
    .map((name) => new URL(String(name), dir))
    .filter((url) => fs.statSync(url).isFile());
  const banned = /192\.168\.|SPARKDASH_TOKEN\s*=\s*['"][^'"]+|sk-[A-Za-z0-9]{8,}/;
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(text, banned, `${file.pathname} must not carry a private address or a token`);
  }
});
