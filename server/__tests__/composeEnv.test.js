/**
 * The compose files must forward every runtime variable the README tells a
 * Docker install to set (#378): a passthrough the docs promise but compose
 * drops silently disables the feature for compose installs.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("docker-compose.yml and docker-compose.image.yml forward the MODEL_PRICES_* variables", () => {
  for (const file of ["docker-compose.yml", "docker-compose.image.yml"]) {
    const compose = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.match(compose, /MODEL_PRICES_FETCH=\$\{MODEL_PRICES_FETCH:-0\}/, `${file}: MODEL_PRICES_FETCH passthrough`);
    assert.match(compose, /MODEL_PRICES_JSON_PATH=\$\{MODEL_PRICES_JSON_PATH:-\}/, `${file}: MODEL_PRICES_JSON_PATH passthrough`);
    // Canary: the files really are the deployment manifests with an environment block.
    assert.match(compose, /MAX_ACTIVE_BENCH_JOBS=/, `${file}: environment block present`);
  }
});
