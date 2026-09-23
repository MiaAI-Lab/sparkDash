import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadRecipes,
  validateRecipe,
  validateRecipeFile,
  getRecipe,
  listRecipes,
} from "../recipes.js";

function writeTempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-1b-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

const VALID_FILE = {
  version: 1,
  nodeId: "gx10-1c2c",
  recipes: [
    {
      name: "llm-tp1",
      kind: "llm",
      engine: "sglang",
      port: 8080,
      image: "lmsysorg/sglang:v1.2.0",
      modelId: "qwen3.8-27b",
      modelPath: "RadixArk/Qwen3.8-27B-NVFP4",
      quantization: "nvfp4",
      contextLength: 262144,
      memFraction: 0.76,
      tpSize: 1,
      footprintMB: 50000,
      containerName: "qwen38-sglang",
      env: {},
      args: ["--context-length", "262144"],
      dependsOn: [],
      description: "Primary LLM",
    },
    {
      name: "comfyui",
      kind: "image",
      engine: "comfyui",
      port: 8188,
      image: "ghcr.io/ai-dock/comfyui:latest",
      footprintMB: 40000,
    },
  ],
};

test("loadRecipes: valid file → RecipeFile + module state set", () => {
  const p = writeTempFile("recipes.json", JSON.stringify(VALID_FILE));
  const file = loadRecipes(p);
  assert.equal(file.version, 1);
  assert.equal(file.nodeId, "gx10-1c2c");
  assert.equal(file.recipes.length, 2);
  // module state
  assert.equal(getRecipe("llm-tp1").name, "llm-tp1");
  assert.equal(getRecipe("comfyui").port, 8188);
  assert.equal(getRecipe("nope"), null);
  assert.equal(listRecipes().length, 2);
});

test("validateRecipe: full valid recipe → {valid:true, errors:[]}", () => {
  assert.deepEqual(validateRecipe(VALID_FILE.recipes[0]), { valid: true, errors: [] });
});

test("validateRecipe: bad name/kind/engine/port/digest/memFraction/env/footprint", () => {
  const bad = {
    name: "Bad_Name!",
    kind: "quantum",
    engine: "",
    port: 70000,
    image: "x",
    imageDigest: "sha256:zz",
    memFraction: 1.5,
    env: { A: 42 },
    footprintMB: -1,
  };
  const { valid, errors } = validateRecipe(bad);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes(".name")));
  assert.ok(errors.some((e) => e.includes(".kind")));
  assert.ok(errors.some((e) => e.includes(".engine")));
  assert.ok(errors.some((e) => e.includes(".port")));
  assert.ok(errors.some((e) => e.includes(".imageDigest")));
  assert.ok(errors.some((e) => e.includes(".memFraction")));
  assert.ok(errors.some((e) => e.includes(".env.A")));
  assert.ok(errors.some((e) => e.includes(".footprintMB")));
});

test("validateRecipe: missing required fields each flagged", () => {
  const { valid, errors } = validateRecipe({ name: "a" });
  assert.equal(valid, false);
  for (const f of ["kind", "engine", "port", "image", "footprintMB"]) {
    assert.ok(
      errors.some((e) => e.includes(`'${f}'`)),
      `should flag missing ${f} — got: ${errors.join("; ")}`
    );
  }
});

test("validateRecipe: non-object inputs", () => {
  assert.equal(validateRecipe(null).valid, false);
  assert.equal(validateRecipe("llm").valid, false);
  assert.equal(validateRecipe([]).valid, false);
  assert.equal(validateRecipe(undefined).valid, false);
});

test("validateRecipe: optional field type violations", () => {
  const { errors } = validateRecipe({
    ...VALID_FILE.recipes[0],
    modelId: 42,
    contextLength: -5,
    tpSize: 0.5,
    args: ["--x", 7],
    dependsOn: null,
  });
  assert.ok(errors.some((e) => e.includes(".modelId")));
  assert.ok(errors.some((e) => e.includes(".contextLength")));
  assert.ok(errors.some((e) => e.includes(".tpSize")));
  assert.ok(errors.some((e) => e.includes(".args")));
  assert.ok(errors.some((e) => e.includes(".dependsOn")));
});

test("validateRecipeFile: valid → {valid:true, errors:[]}", () => {
  assert.deepEqual(validateRecipeFile(VALID_FILE), { valid: true, errors: [] });
});

test("validateRecipeFile: duplicate recipe names rejected", () => {
  const dup = {
    version: 1,
    nodeId: "n",
    recipes: [VALID_FILE.recipes[0], { ...VALID_FILE.recipes[0] }],
  };
  const r = validateRecipeFile(dup);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("duplicate recipe name")));
});

test("validateRecipeFile: missing top-level fields", () => {
  const r = validateRecipeFile({ recipes: [] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("version")));
  assert.ok(r.errors.some((e) => e.includes("nodeId")));
  assert.equal(validateRecipeFile("nope").valid, false);
});

test("loadRecipes: missing path → readable throw", () => {
  assert.throws(() => loadRecipes("/nonexistent/recipes-1b.json"), /cannot read/);
});

test("loadRecipes: invalid JSON → readable throw", () => {
  const p = writeTempFile("bad.json", "{not json");
  assert.throws(() => loadRecipes(p), /invalid JSON/);
});

test("loadRecipes: schema-invalid file → throw listing violations", () => {
  const p = writeTempFile(
    "schema.json",
    JSON.stringify({ version: 1, nodeId: "n", recipes: [{ name: "X" }] })
  );
  assert.throws(() => loadRecipes(p), /schema violation/);
});

test("getRecipe/listRecipes: explicit file arg, null-safe", () => {
  assert.equal(getRecipe("llm-tp1", VALID_FILE).engine, "sglang");
  assert.deepEqual(listRecipes(VALID_FILE).map((r) => r.name), ["llm-tp1", "comfyui"]);
  assert.equal(getRecipe("x", null), null);
  assert.deepEqual(listRecipes(null), []);
  assert.deepEqual(listRecipes({}), []);
});
