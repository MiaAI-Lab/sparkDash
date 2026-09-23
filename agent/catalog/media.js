/**
 * sparkdash-node-agent — media services catalog.
 *
 * The media subset of the node's recipe catalog: video generation (LTX,
 * served through ComfyUI), image generation (ComfyUI), TTS (qwen3-tts),
 * STT (qwen3-asr), and voice conversation (matrix-voip).
 *
 * Mirrors the Batch 1B catalog modules:
 *  - recipes.js  pattern: load → parse → validate → retain module state, so
 *    getMediaRecipe() can resolve without a file argument
 *  - services.js pattern: recipe × liveState join → ServiceInstance[]; the
 *    join itself is DELEGATED to services.js's listServices() (single source
 *    of truth for status rules and field defaults). listMediaServices()
 *    first filters to media kinds, so a mixed recipe file yields only
 *    media services.
 *
 * Media recipes validate against shared/recipe.schema.json via recipes.js's
 * validator, with the kind/engine enums restricted to the media subset
 * (MEDIA_KINDS / MEDIA_ENGINES). A non-media recipe (e.g. kind "llm") in a
 * media recipe file is a schema violation, not a warning.
 *
 * Shared port, by design: video and image both run in ONE ComfyUI container
 * (same image, same port 8188) — one container, two catalog entries. Media
 * recipes therefore do NOT enforce port uniqueness; the base schema
 * validator enforces name uniqueness only. Both entries reflect the shared
 * port's live state in the join.
 *
 * Seam contract: shared/types.ts (ServiceInstance) + shared/recipe.schema.json.
 * Style: Node.js ESM, plain JS (JSDoc), no build step, zero dependencies
 * (node built-ins only).
 *
 * Module state: the most recent loadMediaRecipes() call is retained so
 * getMediaRecipe() can resolve against it without a file argument. It also
 * accepts an explicit RecipeFile to stay testable without fs.
 */

import fs from "node:fs";

import { validateRecipeFile } from "./recipes.js";
import { listServices } from "./services.js";

/** Media service kinds (Recipe.kind subset allowed in a media recipe file). */
export const MEDIA_KINDS = ["video", "image", "tts", "stt", "voice"];

/** Media service engines allowed in a media recipe file. */
export const MEDIA_ENGINES = [
  "comfyui",
  "ltx",
  "qwen3-tts",
  "qwen3-asr",
  "matrix-voip",
];

/**
 * One media service recipe (shape: shared/recipe.schema.json →
 * definitions.Recipe, with kind restricted to MEDIA_KINDS and engine to
 * MEDIA_ENGINES).
 * @typedef {import("./recipes.js").Recipe} MediaRecipe
 */

/**
 * A per-node media recipe file (shape: shared/recipe.schema.json → top level).
 * @typedef {import("./recipes.js").RecipeFile} MediaRecipeFile
 */

/**
 * Validate a media recipe file: base RecipeFile schema (via recipes.js),
 * plus the media kind/engine restriction on every recipe.
 *
 * @param {unknown} file
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateMediaRecipeFile(file) {
  const base = validateRecipeFile(file);
  if (!base.valid) return base;
  const errors = [];
  const recipes = Array.isArray(file.recipes) ? file.recipes : [];
  recipes.forEach((r, i) => {
    if (typeof r?.kind === "string" && !MEDIA_KINDS.includes(r.kind)) {
      errors.push(
        `recipes[${i}].kind '${r.kind}' is not a media kind (one of ${JSON.stringify(MEDIA_KINDS)})`
      );
    }
    if (typeof r?.engine === "string" && !MEDIA_ENGINES.includes(r.engine)) {
      errors.push(
        `recipes[${i}].engine '${r.engine}' is not a media engine (one of ${JSON.stringify(
          MEDIA_ENGINES
        )})`
      );
    }
  });
  return { valid: errors.length === 0, errors };
}

// ── module state: last loaded file ─────────────────────────────────────────

let _file = null;

/**
 * Read, parse, and validate a media recipe file.
 *
 * @param {string} path path to the media recipe JSON file
 * @returns {MediaRecipeFile}
 * @throws {TypeError} on a non-string / empty path
 * @throws {Error} on unreadable file, invalid JSON, or schema violation
 */
export function loadMediaRecipes(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("loadMediaRecipes: path must be a non-empty string");
  }
  let raw;
  try {
    raw = fs.readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`loadMediaRecipes: cannot read ${path}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`loadMediaRecipes: invalid JSON in ${path}: ${err.message}`);
  }
  const { valid, errors } = validateMediaRecipeFile(data);
  if (!valid) {
    throw new Error(`loadMediaRecipes: schema violation in ${path}: ${errors.join("; ")}`);
  }
  _file = data;
  return data;
}

/**
 * Find one media recipe by name.
 *
 * @param {string} name
 * @param {MediaRecipeFile|null} [file] defaults to the last loadMediaRecipes() result
 * @returns {MediaRecipe|null}
 */
export function getMediaRecipe(name, file = _file) {
  if (typeof name !== "string" || !file || !Array.isArray(file.recipes)) return null;
  return file.recipes.find((r) => r && r.name === name) || null;
}

/**
 * Join media recipes with live state into ServiceInstance[] (shared/types.ts).
 *
 * Delegates the join to services.js's listServices() (single source of truth
 * for status rules: explicit live status override → running → stopped; live
 * modelId/engineVersion when running, recipe/image-tag fallback otherwise;
 * active = kind==="llm" && running, so media entries are never active).
 *
 * Filters to media kinds first (MEDIA_KINDS), so a mixed recipe file yields
 * only media services. video and image may share one port (one ComfyUI
 * container, two entries); both entries reflect that port's live state.
 *
 * @param {import("./recipes.js").Recipe[]} recipes
 * @param {Record<number|string, import("./services.js").LivePortState>|null} [liveState]
 * @returns {import("./services.js").ServiceInstance[]}
 * @throws {TypeError} on non-array recipes
 */
export function listMediaServices(recipes, liveState = null) {
  if (!Array.isArray(recipes)) {
    throw new TypeError("recipes must be an array");
  }
  const media = recipes.filter(
    (r) => r && typeof r.kind === "string" && MEDIA_KINDS.includes(r.kind)
  );
  return listServices(media, liveState);
}
