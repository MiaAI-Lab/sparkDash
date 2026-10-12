import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { APPLICATION_TEXT_MAX_LENGTH, applicationTextI18n } from "../../src/shared/applicationText.js";
import { jobErrorI18n, responseI18n } from "./messages.js";

test("recognition budget declines oversized known messages without truncating diagnostics", () => {
  const raw = "HTTP 502: " + "远程输出\n".repeat(2000);
  assert.ok(applicationTextI18n(raw) === undefined, "oversized text is not recognized");
  assert.equal(jobErrorI18n(raw).params.detail, raw);
  const output = responseI18n({ error: raw });
  assert.equal(output.error, raw);
  assert.equal(output.i18n.error.params.detail, raw);
});

test("literal matching preserves earliest feasible captures and complete multiline diagnostics", () => {
  const input = "SSH config missing for a: host=part: host=host, user=用户";
  const match = applicationTextI18n(input);
  assert.equal(match.key, "server.error.sshConfig");
  assert.deepEqual(match.params, { id: "a", host: "part: host=host", user: "用户" });
  assert.deepEqual(applicationTextI18n("HTTP 502: first\nlast\n").params, { status: "502", detail: "first\nlast\n" });
  assert.equal(applicationTextI18n("Installed (0.8.2)\n"), undefined);
  assert.equal(applicationTextI18n("SSH config missing for : host=host, user=user"), undefined);
});

test("recognition budget includes its exact boundary and rejects one code unit more", () => {
  const version = "v".repeat(APPLICATION_TEXT_MAX_LENGTH - "Installed ()".length);
  assert.equal(applicationTextI18n(`Installed (${version})`).params.version, version);
  assert.equal(applicationTextI18n(`Installed (${version}v)`), undefined);
});

test("malformed repetitive remote diagnostics cannot hold the process in regex backtracking", () => {
  const moduleUrl = new URL("../../src/shared/applicationText.js", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { applicationTextI18n } from ${JSON.stringify(moduleUrl)};
    for (const raw of [
      ('1/2 keys, ').repeat(4000) + 'unfinished',
      'SSH config missing for ' + ': host=x'.repeat(10000) + ', user=',
      ('1/2 keys, ').repeat(350) + 'unfinished'
    ]) assert.equal(applicationTextI18n(raw), undefined);
    assert.equal(applicationTextI18n('3/5 keys, 1 stale').key, 'server.quality.keysStale');
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 2000, encoding: "utf8" });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});
