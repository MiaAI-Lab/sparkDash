import path from "node:path";

/**
 * Every environment variable that points the server at a file under config/.
 * A test that spawns `server/index.js` must pass these (pointing into a temp dir),
 * or it reads and writes the real install's files: a "running" bench checkpoint
 * would be marked interrupted, an archive moved aside, and so on.
 * `isolatedEnv.test.js` fails when server code starts using a path variable missing here.
 */
export const CONFIG_PATH_VARS = [
  "SPARKS_JSON_PATH",
  "SPARKS_SECRETS_PATH",
  "SECRETS_KEY_PATH",
  "SETTINGS_JSON_PATH",
  "LLM_DAILY_JSON_PATH",
  "LLM_TOKEN_JSON_PATH",
  "LLM_LAUNCHERS_JSON_PATH",
  "TOOL_EVAL_RUNS_PATH",
  "SHOWCASE_HISTORY_PATH",
  "BENCH_HISTORY_PATH",
  "BENCH_ACTIVE_PATH",
  "PREFILL_BENCH_HISTORY_PATH",
  "PREFILL_BENCH_ACTIVE_PATH",
  "QUALITY_BENCH_HISTORY_PATH",
  "QUALITY_BENCH_ACTIVE_PATH",
  "GPU_MEMORY_JSON_PATH",
  "GPU_HISTORY_JSON_PATH",
  "GPU_HISTORY_LONG_JSON_PATH",
  "METRICS_HISTORY_JSON_PATH",
  "FLEET_ENERGY_JSON_PATH",
  "FLEET_ENERGY_MONTHLY_JSON_PATH",
  "EVENTS_JSON_PATH",
  "ALERTS_JSON_PATH",
  "OCCUPANCY_HELPERS_JSON_PATH",
  "MODEL_PRICES_JSON_PATH",
  "MODEL_PRICES_FETCH",
  "MEMORY_MODE_LOG_PATH",
];

/** Variables that point at a directory the server writes into. */
export const CONFIG_DIR_VARS = ["TOOL_EVAL_RESULTS_DIR", "QWEN_DIR"];

/**
 * Operator/env variables pinned to "" so a spawned test server can never pick
 * them up from the operator's shell or the repo's .env (dotenv leaves
 * already-defined keys untouched). Tests that want them pass values explicitly.
 */
export const PINNED_EMPTY_VARS = [
  "SPARKDASH_INFERENCE_ACTIVITY_URL",
  "SPARKDASH_INFERENCE_ACTIVITY_LABELS",
  "SPARKDASH_TOKEN",
  "DASHBOARD_TOKEN",
  "MEMORY_MODE_ENABLED",
  "QWEN_CONTAINER",
  "OLLAMA_STACK",
  "MEMORY_FLOOR_GB",
];

/** Env entries mapping each config path variable to a file (or directory) inside `dir`. */
export function isolatedConfigEnv(dir) {
  return {
    // Operator settings that must never leak into a spawned test server —
    // including through the repo's .env, since dotenv leaves defined keys alone.
    ...Object.fromEntries(PINNED_EMPTY_VARS.map((name) => [name, ""])),
    ...Object.fromEntries(
      CONFIG_PATH_VARS.map((name) => [
        name,
        path.join(dir, name === "SECRETS_KEY_PATH" ? ".secrets-key" : name === "SPARKS_JSON_PATH" ? "sparks.json" : `${name.toLowerCase()}.json`),
      ])
    ),
    ...Object.fromEntries(CONFIG_DIR_VARS.map((name) => [name, path.join(dir, name.toLowerCase())])),
  };
}
