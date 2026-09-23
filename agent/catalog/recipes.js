/**
 * sparkdash-node-agent — recipe catalog: loader + validator.
 *
 * A recipe is a declarative description of a service that CAN run on this
 * node: model, engine, image, port, memory footprint. Per-node recipe files
 * (agent/config/recipes.json) are validated against shared/recipe.schema.json
 * (JSON Schema draft-07). This module implements that schema with a
 * dependency-free validator — no ajv, no build step.
 *
 * Seam contract: shared/types.ts + shared/recipe.schema.json.
 * Style: Node.js ESM, plain JS (JSDoc), mirrors server/sparks/SparkRegistry.js
 * (load → validate → expose).
 *
 * Module state: the most recent loadRecipes() call is retained so
 * getRecipe()/listRecipes() can resolve against it without a file argument.
 * Both also accept an explicit RecipeFile to stay testable without fs.
 */

import fs from "fs";

/** Service kinds allowed by the schema (Recipe.kind enum). */
export const RECIPE_KINDS = ["llm", "image", "video", "tts", "stt", "voice", "other"];

/** Schema: Recipe.name — ^[a-z0-9][a-z0-9._-]{0,63}$ */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Schema: Recipe.imageDigest — ^sha256:[a-f0-9]{64}$ */
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function isNullishString(v) {
  return v === null || typeof v === "string";
}

/**
 * One service recipe (shape: shared/recipe.schema.json → definitions.Recipe).
 * @typedef {object} Recipe
 * @property {string} name unique service name
 * @property {"llm"|"image"|"video"|"tts"|"stt"|"voice"|"other"} kind
 * @property {string} engine sglang / vllm / comfyui / qwen3-tts / qwen3-asr / matrix-voip / other
 * @property {number} port 1–65535
 * @property {string} image docker image reference
 * @property {string|null} [imageDigest] pinned sha256 digest
 * @property {string|null} [modelId]
 * @property {string|null} [modelPath]
 * @property {string|null} [modelRevision]
 * @property {string|null} [quantization]
 * @property {number|null} [contextLength]
 * @property {number|null} [memFraction] 0–1
 * @property {number|null} [tpSize] >= 1
 * @property {number} footprintMB >= 0
 * @property {string|null} [containerName]
 * @property {string|null} [systemdUnit]
 * @property {Record<string,string>} [env]
 * @property {string[]} [args]
 * @property {string[]} [dependsOn]
 * @property {string|null} [description]
 */

/**
 * A per-node recipe file (shape: shared/recipe.schema.json → top level).
 * @typedef {object} RecipeFile
 * @property {number} version schema version (currently 1)
 * @property {string} nodeId node id this file applies to
 * @property {Recipe[]} recipes
 */

/**
 * Validate one recipe against the Recipe definition.
 * @param {unknown} recipe
 * @param {string} [label] human-readable location, used in error messages
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateRecipe(recipe, label = "recipe") {
  const errors = [];
  if (typeof recipe !== "object" || recipe === null || Array.isArray(recipe)) {
    return { valid: false, errors: [`${label} must be an object`] };
  }

  for (const field of ["name", "kind", "engine", "port", "image", "footprintMB"]) {
    if (!Object.prototype.hasOwnProperty.call(recipe, field)) {
      errors.push(`${label} missing required field '${field}'`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(recipe, "name")) {
    if (typeof recipe.name !== "string" || !NAME_RE.test(recipe.name)) {
      errors.push(`${label}.name must match ${NAME_RE} (got ${JSON.stringify(recipe.name)})`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(recipe, "kind")) {
    if (typeof recipe.kind !== "string" || !RECIPE_KINDS.includes(recipe.kind)) {
      errors.push(
        `${label}.kind must be one of ${JSON.stringify(RECIPE_KINDS)} (got ${JSON.stringify(recipe.kind)})`
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(recipe, "engine")) {
    if (typeof recipe.engine !== "string" || recipe.engine.length === 0) {
      errors.push(`${label}.engine must be a non-empty string`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(recipe, "port")) {
    if (!Number.isInteger(recipe.port) || recipe.port < 1 || recipe.port > 65535) {
      errors.push(`${label}.port must be an integer 1–65535 (got ${JSON.stringify(recipe.port)})`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(recipe, "image")) {
    if (typeof recipe.image !== "string" || recipe.image.length === 0) {
      errors.push(`${label}.image must be a non-empty string`);
    }
  }

  // Optional string|null fields
  const nullableStrings = [
    "imageDigest",
    "modelId",
    "modelPath",
    "modelRevision",
    "quantization",
    "containerName",
    "systemdUnit",
    "description",
  ];
  for (const field of nullableStrings) {
    if (Object.prototype.hasOwnProperty.call(recipe, field) && !isNullishString(recipe[field])) {
      errors.push(`${label}.${field} must be a string or null`);
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(recipe, "imageDigest") &&
    typeof recipe.imageDigest === "string" &&
    !DIGEST_RE.test(recipe.imageDigest)
  ) {
    errors.push(
      `${label}.imageDigest must match sha256:<64 hex> (got ${JSON.stringify(recipe.imageDigest)})`
    );
  }

  // Optional number fields
  if (Object.prototype.hasOwnProperty.call(recipe, "contextLength")) {
    const v = recipe.contextLength;
    if (!(v === null || (isFiniteNumber(v) && v > 0))) {
      errors.push(`${label}.contextLength must be a positive number or null (got ${JSON.stringify(v)})`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(recipe, "memFraction")) {
    const v = recipe.memFraction;
    if (!(v === null || (isFiniteNumber(v) && v >= 0 && v <= 1))) {
      errors.push(`${label}.memFraction must be a number in [0,1] or null (got ${JSON.stringify(v)})`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(recipe, "tpSize")) {
    const v = recipe.tpSize;
    if (!(v === null || (Number.isInteger(v) && v >= 1))) {
      errors.push(`${label}.tpSize must be an integer >= 1 or null (got ${JSON.stringify(v)})`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(recipe, "footprintMB")) {
    const v = recipe.footprintMB;
    if (!(isFiniteNumber(v) && v >= 0)) {
      errors.push(`${label}.footprintMB must be a non-negative finite number (got ${JSON.stringify(v)})`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(recipe, "env")) {
    const env = recipe.env;
    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      errors.push(`${label}.env must be an object`);
    } else {
      for (const [k, v] of Object.entries(env)) {
        if (typeof v !== "string") {
          errors.push(`${label}.env.${k} must be a string (got ${JSON.stringify(v)})`);
        }
      }
    }
  }
  for (const field of ["args", "dependsOn"]) {
    if (Object.prototype.hasOwnProperty.call(recipe, field)) {
      const arr = recipe[field];
      if (!Array.isArray(arr) || arr.some((x) => typeof x !== "string")) {
        errors.push(`${label}.${field} must be an array of strings`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a full RecipeFile: version/nodeId/recipes + every recipe + name
 * uniqueness (the schema's Recipe.name is documented as "unique service name").
 * @param {unknown} file
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateRecipeFile(file) {
  if (typeof file !== "object" || file === null || Array.isArray(file)) {
    return { valid: false, errors: ["RecipeFile must be an object"] };
  }
  const errors = [];
  if (typeof file.version !== "number" || !Number.isFinite(file.version)) {
    errors.push(`version must be a finite number (got ${JSON.stringify(file.version)})`);
  }
  if (typeof file.nodeId !== "string" || file.nodeId.length === 0) {
    errors.push(`nodeId must be a non-empty string (got ${JSON.stringify(file.nodeId)})`);
  }
  if (!Array.isArray(file.recipes)) {
    errors.push("recipes must be an array");
  } else {
    const seen = new Set();
    file.recipes.forEach((r, i) => {
      errors.push(...validateRecipe(r, `recipes[${i}]`).errors);
      if (typeof r?.name === "string" && r.name.length > 0) {
        if (seen.has(r.name)) {
          errors.push(`recipes[${i}] duplicate recipe name '${r.name}'`);
        }
        seen.add(r.name);
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

// ── module state: last loaded file ─────────────────────────────────────────

let _file = null;

/**
 * Read, parse, and validate a recipe file.
 * @param {string} path path to the recipe JSON file
 * @returns {RecipeFile}
 * @throws {Error} on unreadable file, invalid JSON, or schema violation
 */
export function loadRecipes(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("loadRecipes: path must be a non-empty string");
  }
  let raw;
  try {
    raw = fs.readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`loadRecipes: cannot read ${path}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`loadRecipes: invalid JSON in ${path}: ${err.message}`);
  }
  const { valid, errors } = validateRecipeFile(data);
  if (!valid) {
    throw new Error(`loadRecipes: schema violation in ${path}: ${errors.join("; ")}`);
  }
  _file = data;
  return data;
}

/**
 * Find one recipe by name.
 * @param {string} name
 * @param {RecipeFile|null} [file] defaults to the last loadRecipes() result
 * @returns {Recipe|null}
 */
export function getRecipe(name, file = _file) {
  if (typeof name !== "string" || !file || !Array.isArray(file.recipes)) return null;
  return file.recipes.find((r) => r && r.name === name) || null;
}

/**
 * List all recipes.
 * @param {RecipeFile|null} [file] defaults to the last loadRecipes() result
 * @returns {Recipe[]}
 */
export function listRecipes(file = _file) {
  if (!file || !Array.isArray(file.recipes)) return [];
  return file.recipes;
}
