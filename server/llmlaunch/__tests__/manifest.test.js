import test from "node:test";
import assert from "node:assert/strict";
import {
  ENV_FILE,
  MANIFEST_FILE,
  MAX_MANIFEST_BYTES,
  MAX_SETTINGS,
  envValue,
  parseEnvFile,
  parseManifest,
  resolveValues,
  serializeEnvFile,
  validateValue,
  validateValues,
} from "../manifest.js";

const setting = (over = {}) => ({
  key: "PROMPT_CACHE_GIB",
  label: "Prompt cache",
  type: "integer",
  default: 4,
  min: 1,
  max: 16,
  step: 1,
  options: null,
  unit: "GiB",
  help: null,
  restart: true,
  memory: "GiB",
  ...over,
});

const manifestOf = (...settings) => ({ version: 1, settings });

test("the manifest and env file names are the documented ones", () => {
  assert.equal(MANIFEST_FILE, "sparkdash-launcher.json");
  assert.equal(ENV_FILE, "launcher.env");
});

test("parseManifest accepts a complete manifest and fills the optional fields", () => {
  const text = JSON.stringify({
    version: 1,
    settings: [
      { key: "PROMPT_CACHE_GIB", label: "Prompt cache", type: "integer", default: 4, min: 1, max: 16, step: 1, unit: "GiB", help: "Server prompt cache", memory: "GiB" },
      { key: "GPU_MEMORY_UTILIZATION", label: "GPU memory", type: "number", default: 0.9, min: 0.5, max: 0.95, step: 0.01 },
      { key: "ENABLE_PREFIX_CACHE", label: "Prefix cache", type: "boolean", default: true, restart: false },
      { key: "ATTENTION_BACKEND", label: "Attention", type: "enum", default: "flashinfer", options: ["flashinfer", "triton"] },
      { key: "MODEL_PATH", label: "Model", type: "string", default: "/models/deepseek" },
    ],
  });
  const parsed = parseManifest(text);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.manifest.version, 1);
  assert.equal(parsed.manifest.settings.length, 5);
  const [cache, gpu, prefix, attention, model] = parsed.manifest.settings;
  assert.deepEqual(cache, {
    key: "PROMPT_CACHE_GIB",
    label: "Prompt cache",
    type: "integer",
    default: 4,
    min: 1,
    max: 16,
    step: 1,
    options: null,
    unit: "GiB",
    help: "Server prompt cache",
    restart: true,
    memory: "GiB",
  });
  assert.equal(gpu.default, 0.9);
  assert.equal(gpu.memory, null, "memory is opt-in");
  assert.equal(prefix.restart, false);
  assert.deepEqual(attention.options, ["flashinfer", "triton"]);
  assert.equal(model.min, null);
  assert.equal(model.unit, null);
});

test("parseManifest rejects a bad version, shape or JSON", () => {
  assert.equal(parseManifest("not json").ok, false);
  assert.equal(parseManifest("[]").ok, false);
  assert.equal(parseManifest(JSON.stringify({ version: 2, settings: [] })).ok, false);
  assert.equal(parseManifest(JSON.stringify({ version: 1 })).ok, false);
  assert.equal(parseManifest(JSON.stringify({ version: 1, settings: {} })).ok, false);
  assert.equal(parseManifest(JSON.stringify({ version: 1, settings: [] })).ok, true, "an empty list is allowed");
});

test("parseManifest rejects keys that are not environment variable names", () => {
  for (const key of ["prompt_cache", "1CACHE", "PROMPT-CACHE", "PROMPT CACHE", "", "A".repeat(65), "PROMPT_CACHE$"]) {
    const parsed = parseManifest(JSON.stringify(manifestOf(setting({ key }))));
    assert.equal(parsed.ok, false, `should reject key ${JSON.stringify(key)}`);
    assert.match(parsed.error, /key/);
  }
  assert.equal(parseManifest(JSON.stringify(manifestOf(setting({ key: "A" })))).ok, true);
  assert.equal(parseManifest(JSON.stringify(manifestOf(setting({ key: "A".repeat(64) })))).ok, true);
});

test("parseManifest rejects unknown types and bad bounds", () => {
  assert.match(parseManifest(JSON.stringify(manifestOf(setting({ type: "float" })))).error, /type/);
  assert.match(parseManifest(JSON.stringify(manifestOf(setting({ min: 20, max: 10 })))).error, /min/);
  assert.match(parseManifest(JSON.stringify(manifestOf(setting({ min: "1" })))).error, /min/);
  assert.match(parseManifest(JSON.stringify(manifestOf(setting({ step: 0 })))).error, /step/);
  assert.match(parseManifest(JSON.stringify(manifestOf(setting({ default: 99 })))).error, /default/);
  assert.match(parseManifest(JSON.stringify(manifestOf(setting({ default: 1.5 })))).error, /default/);
  assert.match(parseManifest(JSON.stringify(manifestOf(setting({ restart: "yes" })))).error, /restart/);
  assert.match(parseManifest(JSON.stringify(manifestOf(setting({ memory: "MiB" })))).error, /memory/);
  assert.match(
    parseManifest(JSON.stringify(manifestOf(setting({ type: "string", default: "x", min: null, max: null, step: null, memory: "GiB" })))).error,
    /memory/
  );
  assert.match(parseManifest(JSON.stringify(manifestOf(setting({ label: "" })))).error, /label/);
  assert.match(parseManifest(JSON.stringify(manifestOf(setting({ label: "x".repeat(81) })))).error, /label/);
});

test("parseManifest rejects enum settings without usable options", () => {
  const base = { key: "BACKEND", label: "Backend", type: "enum", default: "a" };
  assert.match(parseManifest(JSON.stringify(manifestOf(base))).error, /options/);
  assert.match(parseManifest(JSON.stringify(manifestOf({ ...base, options: [] }))).error, /options/);
  assert.match(parseManifest(JSON.stringify(manifestOf({ ...base, options: ["a", "a"] }))).error, /repeats/);
  assert.match(parseManifest(JSON.stringify(manifestOf({ ...base, options: ["a", "b c"] }))).error, /options/);
  assert.match(parseManifest(JSON.stringify(manifestOf({ ...base, options: ["a", "b"], default: "c" }))).error, /default/);
  assert.match(parseManifest(JSON.stringify(manifestOf(setting({ options: ["a"] })))).error, /options/);
  assert.equal(parseManifest(JSON.stringify(manifestOf({ ...base, options: ["a", "b"] }))).ok, true);
});

test("parseManifest rejects duplicate keys, too many settings and an oversize file", () => {
  const dup = parseManifest(JSON.stringify(manifestOf(setting(), setting())));
  assert.equal(dup.ok, false);
  assert.match(dup.error, /repeats/);

  const many = Array.from({ length: MAX_SETTINGS + 1 }, (_, i) => setting({ key: `SETTING_${i}` }));
  assert.match(parseManifest(JSON.stringify(manifestOf(...many))).error, /more than/);

  const padded = JSON.stringify({ version: 1, settings: [], padding: "x".repeat(MAX_MANIFEST_BYTES + 1) });
  assert.match(parseManifest(padded).error, /larger than/);
});

test("validateValue enforces type, bounds and the string allow-list", () => {
  const cache = setting();
  assert.deepEqual(validateValue(cache, 4), { ok: true, value: 4 });
  assert.deepEqual(validateValue(cache, "8"), { ok: true, value: 8 });
  assert.equal(validateValue(cache, 1.5).ok, false);
  assert.equal(validateValue(cache, "1.5").ok, false);
  assert.equal(validateValue(cache, "").ok, false);
  assert.equal(validateValue(cache, "0x10").ok, false);
  assert.equal(validateValue(cache, 0).ok, false);
  assert.equal(validateValue(cache, 17).ok, false);
  assert.equal(validateValue(cache, null).ok, false);

  const gpu = setting({ key: "GPU_MEMORY_UTILIZATION", type: "number", default: 0.9, min: 0.5, max: 0.95, memory: null });
  assert.deepEqual(validateValue(gpu, "0.75"), { ok: true, value: 0.75 });
  assert.equal(validateValue(gpu, 0.4).ok, false);
  assert.equal(validateValue(gpu, 1).ok, false);

  const flag = setting({ key: "ENABLE_PREFIX_CACHE", type: "boolean", default: true, min: null, max: null, memory: null });
  assert.deepEqual(validateValue(flag, true), { ok: true, value: true });
  assert.deepEqual(validateValue(flag, "false"), { ok: true, value: false });
  assert.equal(validateValue(flag, "yes").ok, false);
  assert.equal(validateValue(flag, 1).ok, false);

  const backend = setting({ key: "BACKEND", type: "enum", default: "a", options: ["a", "b"], min: null, max: null, memory: null });
  assert.deepEqual(validateValue(backend, "b"), { ok: true, value: "b" });
  assert.equal(validateValue(backend, "c").ok, false);

  const path = setting({ key: "MODEL_PATH", type: "string", default: "/models/x", min: null, max: null, memory: null });
  assert.deepEqual(validateValue(path, "/models/deepseek-v3"), { ok: true, value: "/models/deepseek-v3" });
  for (const bad of ["a b", "a'b", 'a"b', "a$b", "a`b", "a\nb", "a;b", "a|b", "a&b", "a\\b", "x".repeat(129)]) {
    assert.equal(validateValue(path, bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test("validateValues requires every declared key and refuses undeclared ones", () => {
  const manifest = manifestOf(setting(), setting({ key: "ENABLE_PREFIX_CACHE", type: "boolean", default: true, min: null, max: null, memory: null }));
  assert.deepEqual(validateValues(manifest, { PROMPT_CACHE_GIB: 8, ENABLE_PREFIX_CACHE: false }), {
    ok: true,
    values: { PROMPT_CACHE_GIB: 8, ENABLE_PREFIX_CACHE: false },
  });
  assert.match(validateValues(manifest, { PROMPT_CACHE_GIB: 8 }).error, /ENABLE_PREFIX_CACHE is missing/);
  assert.match(validateValues(manifest, { PROMPT_CACHE_GIB: 8, ENABLE_PREFIX_CACHE: true, EXTRA: 1 }).error, /EXTRA is not declared/);
  assert.match(validateValues(manifest, { PROMPT_CACHE_GIB: 99, ENABLE_PREFIX_CACHE: true }).error, /at most 16/);
  assert.equal(validateValues(manifest, null).ok, false);
  assert.equal(validateValues(manifest, []).ok, false);
});

test("serializeEnvFile writes one KEY=value line per declared setting", () => {
  const manifest = manifestOf(
    setting(),
    setting({ key: "ENABLE_PREFIX_CACHE", type: "boolean", default: true, min: null, max: null, memory: null }),
    setting({ key: "MODEL_PATH", type: "string", default: "/models/x", min: null, max: null, memory: null })
  );
  const text = serializeEnvFile(manifest, { PROMPT_CACHE_GIB: 8, ENABLE_PREFIX_CACHE: false, MODEL_PATH: "/models/deepseek" });
  assert.equal(
    text,
    [
      "# sparkDash launcher settings. Change them in the Models panel; this file is rewritten on save.",
      "PROMPT_CACHE_GIB=8",
      "ENABLE_PREFIX_CACHE=false",
      "MODEL_PATH=/models/deepseek",
      "",
    ].join("\n")
  );
  assert.equal(envValue(setting(), 4), "4");
  assert.equal(envValue(setting({ type: "boolean" }), true), "true");
});

test("parseEnvFile reads KEY=value lines and ignores everything else", () => {
  const parsed = parseEnvFile(
    ["# a comment", "", "PROMPT_CACHE_GIB=8", "  ENABLE_PREFIX_CACHE = true  ", "not a line", "=x", "lower=1", "MODEL_PATH=/models/x"].join("\n")
  );
  assert.deepEqual(parsed, { PROMPT_CACHE_GIB: "8", ENABLE_PREFIX_CACHE: "true", MODEL_PATH: "/models/x" });
  assert.deepEqual(parseEnvFile(""), {});
  assert.deepEqual(parseEnvFile(null), {});
});

test("resolveValues falls back to defaults and reports values the manifest rejects", () => {
  const manifest = manifestOf(setting(), setting({ key: "ENABLE_PREFIX_CACHE", type: "boolean", default: true, min: null, max: null, memory: null }));
  const { values, invalid } = resolveValues(manifest, { PROMPT_CACHE_GIB: "8", ENABLE_PREFIX_CACHE: "maybe" });
  assert.deepEqual(values, { PROMPT_CACHE_GIB: 8, ENABLE_PREFIX_CACHE: true });
  assert.deepEqual(invalid, [{ key: "ENABLE_PREFIX_CACHE", raw: "maybe" }]);

  const empty = resolveValues(manifest, {});
  assert.deepEqual(empty.values, { PROMPT_CACHE_GIB: 4, ENABLE_PREFIX_CACHE: true });
  assert.deepEqual(empty.invalid, []);
});
