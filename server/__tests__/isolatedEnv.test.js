import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR_VARS, CONFIG_PATH_VARS, isolatedConfigEnv } from "./isolatedEnv.js";

const SERVER = path.resolve(import.meta.dirname, "..");
// Directories and binaries, not files under config/.
const NOT_CONFIG_FILES = new Set(["PATH", "HOST_PROC_PATH", "HOST_SYS_PATH", "HOST_ROOT_PATH", "SSH_IDENTITY_FILE"]);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" ? [] : sourceFiles(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

test("every config path variable the server reads can be isolated by tests", () => {
  const used = new Set();
  for (const file of sourceFiles(SERVER)) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(/process\.env\.([A-Z0-9_]*(?:_PATH|_FILE|_DIR))\b/g)) used.add(m[1]);
  }
  for (const name of NOT_CONFIG_FILES) used.delete(name);
  const missing = [...used].filter((name) => !CONFIG_PATH_VARS.includes(name) && !CONFIG_DIR_VARS.includes(name));
  assert.deepEqual(missing, [], `add to CONFIG_PATH_VARS: ${missing.join(", ")}`);
});

test("isolatedConfigEnv keeps every file inside the given directory", () => {
  const env = isolatedConfigEnv("/tmp/x");
  for (const value of Object.values(env)) assert.ok(value.startsWith("/tmp/x/"), value);
  assert.equal(Object.keys(env).length, CONFIG_PATH_VARS.length + CONFIG_DIR_VARS.length);
});
