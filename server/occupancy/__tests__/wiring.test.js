import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("occupancy routes sit behind dashboard auth and snapshots only graft conversations", () => {
  const server = fs.readFileSync(path.join(root, "server/index.js"), "utf8");
  const authAt = server.indexOf("app.use(createAuthMiddleware());");
  const registerAt = server.indexOf("occupancy.register(app);");
  assert.ok(authAt > 0);
  assert.ok(registerAt > authAt);
  assert.match(server, /conversations: conversations\[snap\.id\] \|\| \{\}/);
  assert.equal(server.includes("_runGeneration"), false);
  const listenAt = server.indexOf("server.listen(PORT, BIND_HOST");
  const startAt = server.indexOf("occupancy.start();");
  assert.ok(startAt > listenAt);
  const shutdownAt = server.indexOf("async function shutdown");
  const stopAt = server.indexOf("await occupancy.stop();");
  assert.ok(stopAt > shutdownAt);
});

test("the helper speaks only initialize and session/list", () => {
  const bridge = fs.readFileSync(path.join(root, "scripts/occupancy-helper/acpBridge.js"), "utf8");
  assert.match(bridge, /ALLOWED_METHODS = new Set\(\["initialize", "session\/list"\]\)/);
  assert.equal(/session\/(new|load|resume|prompt|cancel)/.test(bridge), false);
  const helper = fs.readFileSync(path.join(root, "scripts/occupancy-helper/index.js"), "utf8");
  assert.match(helper, /Refusing to bind all interfaces/);
  assert.match(helper, /Refusing a reachable bind without OCCUPANCY_TOKEN/);
});
