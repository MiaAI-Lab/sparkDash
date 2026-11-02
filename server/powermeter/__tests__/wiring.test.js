import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

test("meters feed the fleet-energy tracker; routes sit behind auth; start after listen; stop on shutdown", () => {
  const server = read("server/index.js");
  assert.match(server, /createPowerMeterRuntime\(\{\s*tracker: fleetEnergyTracker,/);
  assert.match(server, /wallReadings: powerMeters\.wallReadings/);
  assert.ok(server.indexOf("const powerMeters") < server.indexOf("const fleetEnergyRuntime"));
  const authAt = server.indexOf("app.use(createAuthMiddleware());");
  const registerAt = server.indexOf("powerMeters.register(app);");
  assert.ok(authAt > 0 && registerAt > authAt);
  assert.ok(server.indexOf("powerMeters.start();") > server.indexOf("server.listen(PORT, BIND_HOST"));
  const shutdownAt = server.indexOf("async function shutdown");
  assert.ok(server.indexOf("powerMeters.stop();") > shutdownAt);
  // The tracker's final flush (fleetEnergyRuntime.stop) comes after the meters stop writing into it.
  assert.ok(server.indexOf("powerMeters.stop();") < server.indexOf("fleetEnergyRuntime.stop();"));
  assert.match(server, /renderPrometheusMetrics\(entries\) \+ powerMeters\.renderPrometheus\(\)/);
});

test("the power-meter tests run with the server suite", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.scripts["test:server"], /server\/powermeter\/__tests__\/\*\.test\.js/);
});

test("the meter module keeps no energy store of its own", () => {
  const dir = path.join(root, "server/powermeter");
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".js") && !f.includes("__tests__"));
  assert.deepEqual(files.sort(), ["config.js", "providers/HomeAssistantProvider.js", "providers/PowerMeterProvider.js", "providers/index.js", "routes.js", "runtime.js"].sort());
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    assert.doesNotMatch(text, /writeStateAtomically|writeFileSync/, `${file} must not persist anything itself`);
  }
});
