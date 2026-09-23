/**
 * Tests: agent/catalog/media.js — media services catalog.
 *
 * Zero dependencies: node:test + node:assert/strict only.
 * Run: node --test agent/catalog/__tests__/media.test.js
 *
 * Covers:
 *  - loadMediaRecipes: valid file → RecipeFile; missing file → readable
 *    throw; invalid JSON → throw; non-media kind → schema-violation throw;
 *    non-string/empty path → TypeError; module state feeds getMediaRecipe()
 *  - listMediaServices: known-answer join (ground truth), empty recipes → [],
 *    non-array → TypeError, stopped/living defaults, live status override,
 *    live modelId/engineVersion, shared-port (video+image @ 8188),
 *    non-media filtering
 *  - getMediaRecipe: valid name → Recipe; missing name → null;
 *    non-string name → null; explicit file arg (non-default module state)
 *  - agent/config/media-recipes.json loads + joins end to end
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  MEDIA_KINDS,
  MEDIA_ENGINES,
  loadMediaRecipes,
  getMediaRecipe,
  listMediaServices,
  validateMediaRecipeFile,
} from "../media.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
/** agent/ directory (this file lives in agent/catalog/__tests__/). */
const AGENT_DIR = path.resolve(TEST_DIR, "..", "..");

const VALID_FILE = {
  version: 1,
  nodeId: "gx10-test",
  recipes: [
    {
      name: "video",
      kind: "video",
      engine: "comfyui",
      port: 8188,
      image: "AEON-7/comfyui-aeon-spark:latest",
      footprintMB: 40000,
      modelId: "ltx-2.3-22b",
      modelPath: "Lightricks/LTX-2.3-22B",
      contextLength: null,
      memFraction: null,
      tpSize: null,
    },
    {
      name: "tts",
      kind: "tts",
      engine: "qwen3-tts",
      port: 3000,
      image: "AEON-7/qwen3-tts-server:latest",
      footprintMB: 5000,
      modelId: "qwen3-tts",
      modelPath: "Qwen/Qwen3-TTS",
      contextLength: null,
      memFraction: null,
      tpSize: null,
    },
  ],
};

/** @returns {string} path to a temp file containing the given JSON text */
function writeTempFile(json) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-media-test-"));
  const p = path.join(dir, "media-recipes.json");
  fs.writeFileSync(p, json, "utf-8");
  return p;
}

// ── vocabulary ──────────────────────────────────────────────────────────────

test("MEDIA_KINDS / MEDIA_ENGINES vocabularies", () => {
  assert.deepEqual(MEDIA_KINDS, ["video", "image", "tts", "stt", "voice"]);
  assert.deepEqual(
    MEDIA_ENGINES,
    ["comfyui", "ltx", "qwen3-tts", "qwen3-asr", "matrix-voip"]
  );
});

// ── loadMediaRecipes ────────────────────────────────────────────────────────

test("loadMediaRecipes: valid file → RecipeFile", () => {
  const p = writeTempFile(JSON.stringify(VALID_FILE));
  const file = loadMediaRecipes(p);
  assert.equal(file.version, 1);
  assert.equal(file.nodeId, "gx10-test");
  assert.equal(file.recipes.length, 2);
  assert.equal(file.recipes[0].name, "video");
  assert.equal(file.recipes[0].footprintMB, 40000);
  assert.equal(file.recipes[1].engine, "qwen3-tts");
});

test("loadMediaRecipes: module state feeds getMediaRecipe() with no file arg", () => {
  const p = writeTempFile(JSON.stringify(VALID_FILE));
  loadMediaRecipes(p);
  const r = getMediaRecipe("tts");
  assert.equal(r.name, "tts");
  assert.equal(r.engine, "qwen3-tts");
});

test("loadMediaRecipes: missing file → readable throw", () => {
  const p = path.join(os.tmpdir(), `definitely-missing-${process.pid}.json`);
  assert.throws(
    () => loadMediaRecipes(p),
    /loadMediaRecipes: cannot read .*definitely-missing/
  );
});

test("loadMediaRecipes: invalid JSON → readable throw", () => {
  const p = writeTempFile("{ not json ");
  assert.throws(() => loadMediaRecipes(p), /loadMediaRecipes: invalid JSON/);
});

test("loadMediaRecipes: non-media kind → schema-violation throw", () => {
  const bad = {
    version: 1,
    nodeId: "n",
    recipes: [
      {
        name: "llm1",
        kind: "llm",
        engine: "sglang",
        port: 8080,
        image: "x:y",
        footprintMB: 100,
      },
    ],
  };
  const p = writeTempFile(JSON.stringify(bad));
  assert.throws(() => loadMediaRecipes(p), /not a media kind/);
});

test("loadMediaRecipes: non-media engine → schema-violation throw", () => {
  const bad = {
    version: 1,
    nodeId: "n",
    recipes: [
      {
        name: "tts1",
        kind: "tts",
        engine: "espeak",
        port: 3000,
        image: "x:y",
        footprintMB: 100,
      },
    ],
  };
  const p = writeTempFile(JSON.stringify(bad));
  assert.throws(() => loadMediaRecipes(p), /not a media engine/);
});

test("loadMediaRecipes: non-string / empty path → TypeError", () => {
  assert.throws(() => loadMediaRecipes(null), TypeError);
  assert.throws(() => loadMediaRecipes(""), TypeError);
});

test("validateMediaRecipeFile: empty recipes array is valid", () => {
  const { valid, errors } = validateMediaRecipeFile({
    version: 1,
    nodeId: "n",
    recipes: [],
  });
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("validateMediaRecipeFile: missing required top-level field is invalid", () => {
  const { valid } = validateMediaRecipeFile({ version: 1, recipes: [] });
  assert.equal(valid, false);
});

// ── listMediaServices ───────────────────────────────────────────────────────

test("listMediaServices: known-answer (video recipe × live port 8188)", () => {
  const recipes = [
    { name: "video", kind: "video", engine: "comfyui", port: 8188, footprintMB: 40000 },
  ];
  const liveState = { 8188: { running: true } };
  const out = listMediaServices(recipes, liveState);
  // ground-truth expected
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "video");
  assert.equal(out[0].status, "running");
  assert.equal(out[0].port, 8188);
  assert.equal(out[0].footprintMB, 40000);
  // full ServiceInstance shape (shared/types.ts)
  assert.equal(out[0].kind, "video");
  assert.equal(out[0].engine, "comfyui");
  // running with no live modelId/engineVersion → null (services.js rules);
  // recipe/image-tag fallbacks apply to stopped services only
  assert.equal(out[0].modelId, null);
  assert.equal(out[0].engineVersion, null);
  assert.equal(out[0].active, false); // media is never "active" (llm-only)
  assert.equal(typeof out[0].polledAt, "number");
});

test("listMediaServices: empty recipes → []", () => {
  assert.deepEqual(listMediaServices([]), []);
});

test("listMediaServices: non-array recipes → TypeError", () => {
  assert.throws(() => listMediaServices(null), TypeError);
  assert.throws(() => listMediaServices({}), TypeError);
  assert.throws(() => listMediaServices("recipes"), TypeError);
});

test("listMediaServices: no live state → stopped + recipe/image-tag defaults", () => {
  const recipes = [
    {
      name: "tts",
      kind: "tts",
      engine: "qwen3-tts",
      port: 3000,
      image: "AEON-7/qwen3-tts-server:latest",
      footprintMB: 5000,
      modelId: "qwen3-tts",
    },
  ];
  const out = listMediaServices(recipes, null);
  assert.equal(out[0].status, "stopped");
  assert.equal(out[0].modelId, "qwen3-tts");
  assert.equal(out[0].engineVersion, "latest");
});

test("listMediaServices: live state overrides (running + live modelId/version)", () => {
  const recipes = [
    {
      name: "stt",
      kind: "stt",
      engine: "qwen3-asr",
      port: 3001,
      image: "AEON-7/qwen3-asr-server:latest",
      footprintMB: 5000,
      modelId: "qwen3-asr",
    },
  ];
  const liveState = {
    3001: { running: true, modelId: "qwen3-asr-0923", engineVersion: "0.9.23" },
  };
  const out = listMediaServices(recipes, liveState);
  assert.equal(out[0].status, "running");
  assert.equal(out[0].modelId, "qwen3-asr-0923"); // live beats recipe
  assert.equal(out[0].engineVersion, "0.9.23"); // live beats image tag
});

test("listMediaServices: explicit live status override (loading)", () => {
  const recipes = [
    {
      name: "voice",
      kind: "voice",
      engine: "matrix-voip",
      port: 3002,
      image: "AEON-7/matrix-voip-agent:latest",
      footprintMB: 3000,
    },
  ];
  const out = listMediaServices(recipes, { 3002: { running: false, status: "loading" } });
  assert.equal(out[0].status, "loading");
});

test("listMediaServices: shared port — video+image both reflect port 8188", () => {
  const recipes = [
    { name: "video", kind: "video", engine: "comfyui", port: 8188, footprintMB: 40000 },
    { name: "image", kind: "image", engine: "comfyui", port: 8188, footprintMB: 40000 },
    { name: "llm", kind: "llm", engine: "sglang", port: 8080, footprintMB: 50000 },
  ];
  const out = listMediaServices(recipes, { 8188: { running: true } });
  // non-media recipe filtered out; both media entries see the shared port
  assert.deepEqual(
    out.map((s) => s.name),
    ["video", "image"]
  );
  assert.ok(out.every((s) => s.status === "running"));
});

// ── getMediaRecipe ──────────────────────────────────────────────────────────

test("getMediaRecipe: valid name → Recipe", () => {
  const p = writeTempFile(JSON.stringify(VALID_FILE));
  loadMediaRecipes(p);
  const r = getMediaRecipe("video");
  assert.equal(r.name, "video");
  assert.equal(r.port, 8188);
  assert.equal(r.modelPath, "Lightricks/LTX-2.3-22B");
});

test("getMediaRecipe: missing name → null", () => {
  const p = writeTempFile(JSON.stringify(VALID_FILE));
  loadMediaRecipes(p);
  assert.equal(getMediaRecipe("nope"), null);
});

test("getMediaRecipe: non-string name → null (no throw)", () => {
  assert.equal(getMediaRecipe(42), null);
  assert.equal(getMediaRecipe(null), null);
});

test("getMediaRecipe: explicit file arg (non-default module state)", () => {
  const r = getMediaRecipe("video", VALID_FILE);
  assert.equal(r.name, "video");
  assert.equal(getMediaRecipe("tts", null), null);
});

// ── real config file ────────────────────────────────────────────────────────

test("agent/config/media-recipes.json: loads and joins end to end", () => {
  const p = path.join(AGENT_DIR, "config", "media-recipes.json");
  const file = loadMediaRecipes(p);
  assert.equal(file.recipes.length, 5);
  const byName = Object.fromEntries(file.recipes.map((r) => [r.name, r]));

  assert.equal(byName.video.port, 8188);
  assert.equal(byName.video.footprintMB, 40000);
  assert.equal(byName.video.modelId, "ltx-2.3-22b");
  assert.equal(byName.image.port, 8188); // shared ComfyUI container
  assert.equal(byName.image.footprintMB, 40000);
  assert.equal(byName.tts.port, 3000);
  assert.equal(byName.tts.engine, "qwen3-tts");
  assert.equal(byName.tts.footprintMB, 5000);
  assert.equal(byName.stt.port, 3001);
  assert.equal(byName.stt.engine, "qwen3-asr");
  assert.equal(byName.stt.footprintMB, 5000);
  assert.equal(byName.voice.port, 3002);
  assert.equal(byName.voice.engine, "matrix-voip");
  assert.equal(byName.voice.footprintMB, 3000);
  assert.deepEqual(byName.voice.dependsOn, ["stt", "tts"]);

  const liveState = {
    8188: { running: true },
    3000: { running: true },
    3001: { running: false },
    3002: { running: false },
  };
  const out = listMediaServices(file.recipes, liveState);
  assert.equal(out.length, 5);
  const status = Object.fromEntries(out.map((s) => [s.name, s.status]));
  assert.deepEqual(status, {
    video: "running",
    image: "running",
    tts: "running",
    stt: "stopped",
    voice: "stopped",
  });
});
