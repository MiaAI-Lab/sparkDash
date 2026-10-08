import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateStartupPreflight } from "../../startupPreflight.js";

test("startup preflight permits loopback and fails closed on direct LAN binding", () => {
  const safe = evaluateStartupPreflight({
    bindHost: "127.0.0.1",
    configWritable: true,
    secretsKey: { present: true, source: "file" },
    sshIdentity: { configured: false },
    localCollectors: { available: true },
  });
  assert.equal(safe.fatal, false);
  assert.equal(safe.authMode, "loopback-only");

  const exposed = evaluateStartupPreflight({
    bindHost: "0.0.0.0",
    tokenConfigured: false,
    configWritable: true,
    secretsKey: { present: true, source: "file" },
    sshIdentity: { configured: false },
    localCollectors: { available: true },
  });
  assert.equal(exposed.fatal, true);
  assert.equal(exposed.authMode, "required-missing");
  assert.match(exposed.errors.join(" "), /SPARKDASH_TOKEN|loopback|reverse proxy|Tailscale/i);

  const authed = evaluateStartupPreflight({
    bindHost: "0.0.0.0",
    tokenConfigured: true,
    configWritable: true,
    secretsKey: { present: true, source: "file" },
    sshIdentity: { configured: false },
    localCollectors: { available: true },
  });
  assert.equal(authed.fatal, false);
  assert.equal(authed.authMode, "bearer");
});

test("startup preflight says plainly when a tokenless remote bind is left open", () => {
  const open = evaluateStartupPreflight({
    bindHost: "0.0.0.0",
    tokenConfigured: false,
    allowOpenRemote: true,
    configWritable: true,
    secretsKey: { present: true, source: "file" },
    sshIdentity: { configured: false },
    localCollectors: { available: true },
  });
  assert.equal(open.fatal, false);
  assert.equal(open.authMode, "open-remote");
  const warning = open.warnings.find((w) => w.includes("0.0.0.0"));
  assert.ok(warning, "expected an open-bind warning");
  assert.match(warning, /is open/);
  assert.match(warning, /SPARKDASH_ALLOW_OPEN_REMOTE is unset or 1/);
  assert.match(warning, /SPARKDASH_TOKEN/);
});

test("Compose files default to loopback and do not hard-code 0.0.0.0", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  for (const file of ["docker-compose.yml", "docker-compose.dev.yml"]) {
    const text = await readFile(join(root, file), "utf8");
    assert.match(text, /BIND_HOST=\$\{BIND_HOST:-127\.0\.0\.1\}/);
    assert.equal(text.includes("BIND_HOST=0.0.0.0"), false);
  }
});
