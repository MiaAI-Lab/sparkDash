/**
 * Module names in one folder must not differ only by letter case. On a
 * case-insensitive filesystem (Windows, default macOS) an extensionless import
 * of either name resolves to whichever file the bundler tries first, so
 * `deleteAdvice.ts` beside `DeleteAdvice.tsx` broke `vite build` there.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;

function caseCollisions(root) {
  const found = [];
  const walk = (dir) => {
    const byName = new Map();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path.join(dir, entry.name));
      } else if (SOURCE_EXTENSIONS.test(entry.name)) {
        const stem = entry.name.replace(SOURCE_EXTENSIONS, "");
        const spellings = byName.get(stem.toLowerCase()) ?? new Set();
        spellings.add(stem);
        byName.set(stem.toLowerCase(), spellings);
      }
    }
    for (const spellings of byName.values()) {
      if (spellings.size > 1) {
        found.push([...spellings].map((stem) => path.relative(repoRoot, path.join(dir, stem)).split(path.sep).join("/")));
      }
    }
  };
  walk(root);
  return found;
}

for (const folder of ["src", "server"]) {
  test(`${folder}/ has no module names that differ only by letter case`, () => {
    assert.deepEqual(caseCollisions(path.join(repoRoot, folder)), []);
  });
}