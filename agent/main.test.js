import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AGENT_VERSION,
  readNodeIdentity,
  resolveRecipesPath,
  loadCatalog,
  resetCatalog,
  createNodeAgent,
} from "./main.js";

test("readNodeIdentity: env overrides + defaults", () => {
  const id = readNodeIdentity({ HOSTNAME: "narthex", NODE_AGENT_PORT: "40000" });
  assert.equal(id.nodeId, "narthex");
  assert.equal(id.port, 40000);
  assert.equal(id.token, null);
  const d = readNodeIdentity({});
  assert.equal(d.nodeId, "unknown");
  assert.equal(d.port, 30091);
  assert.equal(d.bind, "0.0.0.0");
});

test("resolveRecipesPath: falls back to example when default is missing", () => {
  // agent/config/recipes.json does not exist in the repo — only the example.
  const p = resolveRecipesPath({});
  assert.ok(p.endsWith(path.join("config", "recipes.example.json")), p);
  assert.ok(fs.existsSync(p));
});

test("resolveRecipesPath: explicit RECIPES_PATH always wins", () => {
  assert.equal(resolveRecipesPath({ RECIPES_PATH: "/tmp/elsewhere.json" }), "/tmp/elsewhere.json");
});

test("loadCatalog: loads example, memoizes, reset clears", () => {
  resetCatalog();
  const a = loadCatalog({});
  assert.equal(a.recipes.length, 3);
  assert.deepEqual(
    a.recipes.map((r) => r.name),
    ["llm-tp1", "llm-tp2", "comfyui"]
  );
  assert.equal(loadCatalog({}), a); // memoized
  resetCatalog();
  assert.notEqual(loadCatalog({}), a);
  resetCatalog();
});

test("loadCatalog: explicit missing RECIPES_PATH → empty catalog, no throw", () => {
  resetCatalog();
  const catalog = loadCatalog({ RECIPES_PATH: path.join(os.tmpdir(), "definitely-missing-recipes.json") });
  assert.deepEqual(catalog.recipes, []);
  assert.equal(catalog.recipeFile.version, 1);
  assert.equal(catalog.recipeFile.nodeId, "unknown");
  resetCatalog();
});

test("createNodeAgent: catalog seam works end-to-end", () => {
  resetCatalog();
  const agent = createNodeAgent({});
  assert.equal(typeof AGENT_VERSION, "string");
  const c = agent.catalog;
  assert.equal(c.getRecipe("llm-tp1").engine, "sglang");
  assert.equal(c.getRecipe("nope"), null);
  assert.equal(c.listRecipes().length, 3);

  const services = c.listServices({ 8080: { running: true, modelId: "qwen3.8-27b" } });
  assert.equal(services.length, 3);
  const llm = services.find((s) => s.name === "llm-tp1");
  assert.equal(llm.status, "running");
  assert.equal(llm.active, true);
  const comfy = services.find((s) => s.name === "comfyui");
  assert.equal(comfy.status, "stopped");
  assert.equal(comfy.active, false);

  const budget = c.computeMemoryBudget(122880, 70000, [], 40000);
  assert.equal(budget.nodeId, agent.identity.nodeId); // node id pre-filled
  assert.equal(budget.freeMB, 52880);
  assert.equal(budget.needMakeRoom, false);

  resetCatalog();
});
