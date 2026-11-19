// The env file is sourced by a launcher's start.sh, so what matters is what a shell
// reads back, not what the serialiser meant to write. These tests write the real
// file and source it with bash.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ENV_FILE, parseEnvFile, parseManifest, resolveValues, serializeEnvFile, validateValues } from "../manifest.js";
import { buildSettingsWriteCommand, parseSettingsWriteOutput } from "../commands.js";

const manifestOf = (settings) => {
  const parsed = parseManifest(JSON.stringify({ version: 1, settings }));
  assert.equal(parsed.ok, true, parsed.error);
  return parsed.manifest;
};

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdenv-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** What a launcher's start.sh sees after `set -a; . ./launcher.env`. */
const sourced = (dir, keys) => {
  const res = spawnSync("bash", ["-c", `set -a; . ./${ENV_FILE}; ${keys.map((k) => `printf '%s=%s\\n' ${k} "$${k}"`).join("; ")}`], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  return Object.fromEntries(res.stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
};

test("every accepted value is read back unchanged by a shell and by the parser", (t) => {
  const manifest = manifestOf([
    { key: "CACHE_GIB", label: "Cache", type: "integer", default: 4, min: 1, max: 1e30 },
    { key: "RATIO", label: "Ratio", type: "number", default: 0.9, min: 0, max: 1e30 },
    { key: "PREFIX", label: "Prefix", type: "boolean", default: true },
    { key: "BACKEND", label: "Backend", type: "enum", default: "a-b", options: ["a-b", "c.d"] },
    { key: "NAME", label: "Name", type: "string", default: "m1" },
  ]);
  const values = { CACHE_GIB: 1000000000000000000000, RATIO: 0.0000001, PREFIX: false, BACKEND: "c.d", NAME: "my-model:1" };
  const checked = validateValues(manifest, values);
  assert.equal(checked.ok, true, checked.error);

  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, ENV_FILE), serializeEnvFile(manifest, checked.values));
  assert.deepEqual(sourced(dir, Object.keys(values)), {
    CACHE_GIB: "1000000000000000000000",
    RATIO: "0.0000001",
    PREFIX: "false",
    BACKEND: "c.d",
    NAME: "my-model:1",
  });

  // And the next read of the file accepts what was written, with the same numbers.
  const back = resolveValues(manifest, parseEnvFile(fs.readFileSync(path.join(dir, ENV_FILE), "utf8")));
  assert.deepEqual(back.invalid ?? [], []);
  assert.equal(back.values.CACHE_GIB, 1e21);
  assert.equal(back.values.RATIO, 1e-7);
});

test("manifest text fields refuse control characters", () => {
  for (const field of ["help", "unit", "label"]) {
    const doc = { key: "X", label: "X", type: "integer", default: 1, [field]: `bad\u0007text` };
    const parsed = parseManifest(JSON.stringify({ version: 1, settings: [doc] }));
    assert.equal(parsed.ok, false, field);
    assert.match(parsed.error, /control characters/, field);
  }
});

const run = (dir, home, env) => {
  const res = spawnSync("sh", ["-c", buildSettingsWriteCommand({ dir, env, nonce: "abc123def456abc123def456" })], {
    env: { PATH: process.env.PATH, HOME: home },
    encoding: "utf8",
  });
  return parseSettingsWriteOutput(res.stdout, "abc123def456abc123def456");
};

test("a launcher.env that is a symlink is refused and its target is left alone", (t) => {
  const home = fs.realpathSync(tmp(t));
  const dir = path.join(home, "model");
  fs.mkdirSync(dir);
  const victim = path.join(home, "victim.txt");
  fs.writeFileSync(victim, "keep me\n");
  fs.symlinkSync(victim, path.join(dir, ENV_FILE));

  const result = run(dir, home, "A=1\n");
  assert.equal(result.ok, false);
  assert.match(result.error, /symlink/);
  assert.equal(fs.readFileSync(victim, "utf8"), "keep me\n");
});

test("a regular launcher.env is replaced whole, mode 0600, with no temp file left behind", (t) => {
  const home = fs.realpathSync(tmp(t));
  const dir = path.join(home, "model");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, ENV_FILE), "OLD=1\n");

  const result = run(dir, home, "A=1\nB=2\n");
  assert.deepEqual(result, { ok: true });
  assert.equal(fs.readFileSync(path.join(dir, ENV_FILE), "utf8"), "A=1\nB=2\n");
  assert.equal((fs.statSync(path.join(dir, ENV_FILE)).mode & 0o777).toString(8), "600");
  assert.deepEqual(fs.readdirSync(dir), [ENV_FILE]);
});

test("a directory outside the home directory is refused", (t) => {
  const home = fs.realpathSync(tmp(t));
  const elsewhere = fs.realpathSync(tmp(t));
  const result = run(elsewhere, home, "A=1\n");
  assert.equal(result.ok, false);
  assert.match(result.error, /not inside/);
  assert.equal(fs.existsSync(path.join(elsewhere, ENV_FILE)), false);
});
