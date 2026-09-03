import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { SystemCollector } from "../SystemCollector.js";

/** Build a local SystemCollector whose modelDirs point at a temp tree. */
function makeTempHost() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "modelshelf-"));
  const hot = path.join(base, "hot");
  const warm = path.join(base, "warm");
  fs.mkdirSync(path.join(hot, "llama-3-8b"), { recursive: true });
  fs.writeFileSync(path.join(hot, "llama-3-8b", "model.safetensors"), Buffer.alloc(4096));
  fs.writeFileSync(path.join(hot, "llama-3-8b", "config.json"), Buffer.alloc(128));
  fs.mkdirSync(warm, { recursive: true });
  fs.writeFileSync(path.join(warm, "embedding.gguf"), Buffer.alloc(2048));
  // Non-model dir: only config.json, no weights — must be ignored.
  fs.mkdirSync(path.join(hot, "not-a-model"));
  fs.writeFileSync(path.join(hot, "not-a-model", "config.json"), Buffer.alloc(64));
  return { base, hot, warm };
}

test("collectModels: scans configured modelDirs and catalogues resident models", async () => {
  const { base, hot, warm } = makeTempHost();
  try {
    const collector = new SystemCollector({
      id: "gx10",
      isLocal: true,
      modelDirs: { hot: [hot], warm: [warm] },
    });
    const models = await collector.collectModels();
    const byName = new Map(models.map((m) => [m.name, m]));
    // Model inside hot dir (subdir containing a weight file) -> size recursed.
    const llama = byName.get("llama-3-8b");
    assert.ok(llama, "expected llama-3-8b dir to be catalogued");
    assert.equal(llama.tier, "hot");
    assert.equal(llama.sizeBytes, 4096 + 128); // model.safetensors + config.json
    // Loose weight file in warm -> reported by file stem.
    const emb = byName.get("embedding");
    assert.ok(emb, "expected loose embedding.gguf to be catalogued");
    assert.equal(emb.tier, "warm");
    assert.equal(emb.sizeBytes, 2048);
    // Non-model dir (no weights) must be absent.
    assert.ok(!byName.has("not-a-model"), "non-model dir must not be catalogued");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("collectModels: empty modelDirs returns []", async () => {
  const collector = new SystemCollector({ id: "gx10", isLocal: true });
  const models = await collector.collectModels();
  assert.deepEqual(models, []);
});

test("collectModels: dedupes by name, first tier wins", async () => {
  const { base, hot, warm } = makeTempHost();
  try {
    // Same model name in both hot and warm dirs.
    fs.mkdirSync(path.join(warm, "llama-3-8b"), { recursive: true });
    fs.writeFileSync(path.join(warm, "llama-3-8b", "model.gguf"), Buffer.alloc(512));
    const collector = new SystemCollector({
      id: "gx10",
      isLocal: true,
      modelDirs: { hot: [hot], warm: [warm] },
    });
    const models = await collector.collectModels();
    const hits = models.filter((m) => m.name === "llama-3-8b");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].tier, "hot"); // hot scanned first
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
