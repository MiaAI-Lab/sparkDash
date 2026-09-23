import test from "node:test";
import assert from "node:assert/strict";

import { listServices, imageTag } from "../services.js";

const LLM_RECIPE = {
  name: "llm-tp1",
  kind: "llm",
  engine: "sglang",
  port: 8080,
  image: "lmsysorg/sglang:v1.2.0",
  modelId: "qwen3.8-27b",
  footprintMB: 50000,
};
const COMFY_RECIPE = {
  name: "comfyui",
  kind: "image",
  engine: "comfyui",
  port: 8188,
  image: "ghcr.io/ai-dock/comfyui:latest",
  modelId: null,
  footprintMB: 40000,
};

test("known-answer: running llm on its port → active with live modelId", () => {
  const out = listServices([{ name: "llm", port: 8080, kind: "llm" }], {
    8080: { running: true, modelId: "qwen3.8-27b" },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "llm");
  assert.equal(out[0].status, "running");
  assert.equal(out[0].modelId, "qwen3.8-27b");
  assert.equal(out[0].active, true);
  // partial recipe → documented defaults
  assert.equal(out[0].engine, "other");
  assert.equal(out[0].footprintMB, 0);
  assert.equal(out[0].engineVersion, null); // no image, not running with live version
  assert.ok(Number.isFinite(out[0].polledAt));
});

test("running service with rich liveState", () => {
  const out = listServices([LLM_RECIPE], {
    8080: { running: true, modelId: "qwen3.8-27b", engineVersion: "v1.2.0" },
  });
  const s = out[0];
  assert.equal(s.status, "running");
  assert.equal(s.modelId, "qwen3.8-27b");
  assert.equal(s.engineVersion, "v1.2.0");
  assert.equal(s.active, true);
  assert.equal(s.footprintMB, 50000);
  assert.equal(s.port, 8080);
});

test("no live state → stopped, recipe modelId, image-tag engineVersion", () => {
  const out = listServices([LLM_RECIPE, COMFY_RECIPE], {});
  assert.equal(out[0].status, "stopped");
  assert.equal(out[0].modelId, "qwen3.8-27b"); // from recipe
  assert.equal(out[0].engineVersion, "v1.2.0"); // from image tag
  assert.equal(out[0].active, false);
  assert.equal(out[1].status, "stopped");
  assert.equal(out[1].modelId, null);
  assert.equal(out[1].engineVersion, "latest");
  assert.equal(out[1].active, false);
});

test("explicit live status (wedged) preserved; not active", () => {
  const out = listServices([LLM_RECIPE], {
    8080: { running: true, status: "wedged", modelId: "qwen3.8-27b" },
  });
  assert.equal(out[0].status, "wedged");
  assert.equal(out[0].active, false);
});

test("explicit live status (loading) preserved", () => {
  const out = listServices([LLM_RECIPE], { 8080: { status: "loading" } });
  assert.equal(out[0].status, "loading");
});

test("non-llm running service → active=false", () => {
  const out = listServices([COMFY_RECIPE], {
    8188: { running: true, modelId: null, engineVersion: "1.3.0" },
  });
  assert.equal(out[0].status, "running");
  assert.equal(out[0].active, false);
});

test("empty recipes → []", () => {
  assert.deepEqual(listServices([]), []);
  assert.deepEqual(listServices([], null), []);
});

test("liveState null / non-object → all stopped, no crash", () => {
  const out = listServices([LLM_RECIPE], null);
  assert.equal(out[0].status, "stopped");
  const out2 = listServices([LLM_RECIPE], 42);
  assert.equal(out2[0].status, "stopped");
});

test("invalid inputs throw readable errors", () => {
  assert.throws(() => listServices(null), /recipes must be an array/);
  assert.throws(() => listServices([{}]), /name/);
  assert.throws(() => listServices([[]]), /must be an object/);
  assert.throws(() => listServices([{ name: "x", port: 0 }]), /port/);
  assert.throws(() => listServices([{ name: "x", port: 99999 }]), /port/);
  assert.throws(() => listServices([{ name: "x", port: 80, footprintMB: -1 }]), /footprintMB/);
});

test("imageTag: edge cases", () => {
  assert.equal(imageTag("lmsysorg/sglang:v1.2.0"), "v1.2.0");
  assert.equal(imageTag("ghcr.io/ai-dock/comfyui:latest"), "latest");
  assert.equal(imageTag("repo/img"), null);
  assert.equal(imageTag("registry:5000/img"), null); // registry port, not tag
  assert.equal(imageTag(null), null);
  assert.equal(imageTag(42), null);
  assert.equal(imageTag(""), null);
});
