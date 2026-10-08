/**
 * Every public option of `tool-eval-bench` that a UI can set, as data.
 *
 * Source of truth for: server-side validation, building the argument list, and the
 * form the Tool Eval page renders (served by GET /api/tool-eval/spec). Mirrors the
 * tool's own parser (src/tool_eval_bench/cli/legacy_parser.py, schema version 7).
 *
 * kind:
 *   bool    --flag                          int / float  --flag N (min / max)
 *   string  --flag text                     text  long free text (system prompt)
 *   choice  --flag one-of                   csv   --flag a,b,c (checked against `pattern`)
 *   list    --flag A B C (nargs *)          repeat  --flag v  (once per item)
 *   path    --flag /abs/or/~/path           url   --flag http(s)://…
 *   json    --flag '{"k":1}' (object)       range  --flag 0.5-1.0
 *
 * Managed by the server, never user-set: --json / --json-file / --no-live (always on),
 * --version, and the one-shot commands --probe / --dry-run / --history / --leaderboard /
 * --export / --compare, which have their own endpoints. The terminal dashboards
 * --spec-live / --decision-live need a real TTY and are intentionally not offered.
 */

export const GROUPS = [
  { id: "connection", label: "Connection", help: "Which model endpoint to test and how to talk to it." },
  { id: "scenarios", label: "Scenarios", help: "Which tool-calling scenarios run." },
  { id: "sampling", label: "Sampling", help: "How the model generates its answers." },
  { id: "run", label: "Run control", help: "Timeouts, repetitions, concurrency and prompt overrides." },
  { id: "scoring", label: "Scoring", help: "How the score is weighted." },
  { id: "output", label: "Output", help: "Labels and where reports are written." },
  { id: "throughput", label: "Throughput benchmark", help: "Prompt processing and generation speed (llama-benchy style)." },
  { id: "spec", label: "Speculative decoding", help: "Effective tokens/s and draft acceptance for speculative / MTP decoding." },
  { id: "pressure", label: "Context pressure", help: "Fill the context window before each scenario to find where quality degrades." },
  { id: "gsm8k", label: "GSM8K (math)", help: "Grade-school math reasoning." },
  { id: "mmlu", label: "MMLU (knowledge)", help: "Multitask knowledge benchmark." },
  { id: "ifeval", label: "IFEval (instructions)", help: "Instruction-following with verifiable constraints." },
  { id: "needle", label: "Needle in a haystack", help: "Long-context retrieval at different depths and lengths." },
  { id: "decision", label: "Decision model", help: "Decision-model scoring on a llama.cpp /v1/systemone endpoint." },
  { id: "advanced", label: "Advanced", help: "Mode switches and one-off tweaks." },
];

export const BACKENDS = [
  "vllm", "litellm", "llamacpp", "sglang", "gemini", "openai", "anthropic", "ninfer", "tensorfold", "halogen", "unknown",
];

export const SPEC_METHODS = [
  "auto", "mtp", "nextn", "draft", "standalone", "dflash", "dspark", "ngram", "ngram_gpu", "eagle", "eagle3", "medusa",
  "mlp_speculator", "suffix", "custom_class",
];

/** Category letters A–P (A–O standard, P = Hard Mode). */
export const CATEGORY_LETTERS = "ABCDEFGHIJKLMNOP".split("");

const ID_ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const CSV = /^[A-Za-z0-9_.,\- ]{1,200}$/;

function o(name, kind, group, label, help, extra = {}) {
  return { name, flag: `--${name}`, kind, group, label, help, ...extra };
}

export const ARG_SPEC = [
  // ── Connection ──
  o("base-url", "url", "connection", "Base URL", "OpenAI-compatible server URL. Empty = this Spark's LLM port on localhost (the run happens on the Spark itself)."),
  o("model", "string", "connection", "Model", "Model name or path. Empty = auto-detected from the server.", { maxLen: 300 }),
  o("backend", "choice", "connection", "Backend label", "Label for reports only; the request format follows the endpoint, not this label.", { choices: BACKENDS }),
  o("provider", "string", "connection", "Provider", "Read the endpoint from TOOL_EVAL_<NAME>_BASE_URL / _API_KEY / _MODEL set on the Spark (e.g. openai, gemini, anthropic).", { pattern: /^[A-Za-z0-9_]{1,40}$/ }),
  o("format", "choice", "connection", "Wire format", "openai, gemini or anthropic (/v1/messages). Default: detected from the base URL.", { choices: ["openai", "gemini", "anthropic"] }),
  o("api-key", "secret", "connection", "API key", "Sent to the tool through its environment, never on a command line. Leave empty to use the key saved for this Spark's port (if any)."),
  o("header", "repeat", "connection", "Extra request headers", "One NAME=VALUE per line. Values are passed through the environment (they may hold tokens). Semicolons are not allowed in values.", { itemPattern: /^[A-Za-z0-9-]{1,60}=[^;\n\r\0]{0,500}$/, maxItems: 20, secret: true }),
  o("session-header", "string", "connection", "Session header", "Header carrying a per-conversation id, e.g. x-opencode-session.", { pattern: /^[A-Za-z0-9-]{1,60}$/ }),

  // ── Scenarios ──
  o("short", "bool", "scenarios", "Short run (core 15)", "Run only the 15 core scenarios (about 2 minutes). Skips the extended and agentic ones."),
  o("scenarios", "list", "scenarios", "Specific scenarios", "Scenario IDs such as TC-01 TC-07. Empty = all.", { itemPattern: ID_ITEM, maxItems: 120 }),
  o("categories", "list", "scenarios", "Categories", "Run only these categories (letters A–P). Empty = all.", { itemPattern: /^[A-Pa-p]$/, maxItems: 16, choices: CATEGORY_LETTERS }),
  o("hardmode", "bool", "scenarios", "Include Hard Mode", "Add the Hard Mode scenarios (category P): adversarial, stateful, transactional."),
  o("hardmode-only", "bool", "scenarios", "Hard Mode only", "Run only Hard Mode scenarios (shortcut for --hardmode --categories P)."),
  o("variant-seed", "int", "scenarios", "Variant seed", "Use versioned deterministic fixture variants; unchanged scenarios stay as controls.", { min: 0, max: 2147483647 }),
  o("scenario-pack", "repeat", "scenarios", "Held-out scenario packs", "Directory of a YAML scenario pack on the Spark, one per line. Pack prompts are withheld from reports.", { itemPattern: /^(~\/|\/)[A-Za-z0-9._@+=,/-]{1,300}$/, maxItems: 10 }),
  o("pack-only", "bool", "scenarios", "Packs only", "Run only the scenarios from the packs above (skip the public suite)."),

  // ── Sampling ──
  o("temperature", "float", "sampling", "Temperature", "Default 0.0 (greedy).", { min: 0, max: 5, default: 0 }),
  o("no-think", "bool", "sampling", "Disable thinking", "Turns off thinking/reasoning (enable_thinking=false). Important for Qwen3 and DeepSeek style models."),
  o("top-p", "float", "sampling", "Top-p", "Nucleus sampling, e.g. 0.9.", { min: 0, max: 1 }),
  o("top-k", "int", "sampling", "Top-k", "e.g. 40.", { min: 0, max: 100000 }),
  o("min-p", "float", "sampling", "Min-p", "Min-p threshold, e.g. 0.05.", { min: 0, max: 1 }),
  o("repeat-penalty", "float", "sampling", "Repeat penalty", "e.g. 1.1.", { min: 0, max: 5 }),
  o("seed", "int", "sampling", "Seed", "Random seed passed to the server for reproducible sampling.", { min: 0, max: 2147483647 }),
  o("backend-kwargs", "json", "sampling", "Backend kwargs (JSON)", "A JSON object merged into every API payload; overrides the individual sampling fields.", { maxLen: 4000 }),

  // ── Run control ──
  o("timeout", "float", "run", "Request timeout (s)", "Per-request timeout. Thinking models may need 120 or more.", { min: 1, max: 7200, default: 60 }),
  o("max-turns", "int", "run", "Max turns per scenario", "Default 8.", { min: 1, max: 100, default: 8 }),
  o("trials", "int", "run", "Trials", "Repeat the whole run N times for Pass@k statistics.", { min: 1, max: 50, default: 1 }),
  o("parallel", "int", "run", "Parallel scenarios", "Run N scenarios concurrently (1 = sequential).", { min: 1, max: 64, default: 1 }),
  o("error-rate", "float", "run", "Injected tool-error rate", "Randomly inject tool errors (0–1) to test robustness.", { min: 0, max: 1, default: 0 }),
  o("no-warmup", "bool", "run", "Skip warm-up", "Do not send the warm-up request first."),
  o("no-preflight", "bool", "run", "Skip model pre-flight", "Skip the strict model availability check."),
  o("no-probe-engine", "bool", "run", "Skip engine probing", "No /version or /health calls to identify the inference engine."),
  o("reference-date", "string", "run", "Reference date", "Override the benchmark's reference date (YYYY-MM-DD).", { pattern: /^\d{4}-\d{2}-\d{2}$/ }),
  o("system-prompt", "text", "run", "System prompt override", "Replaces the built-in prompt for every scenario (max 32 KiB). Part of the run fingerprint.", { maxBytes: 32768 }),
  o("system-prompt-file", "path", "run", "System prompt file", "Path on the Spark to a UTF-8 file (max 32 KiB). Cannot be combined with the text above."),
  o("skip-tool-eval", "bool", "run", "Skip tool-call scenarios", "Use together with throughput or speculative-decoding benchmarks."),
  o("resume", "string", "run", "Resume run", "Continue an interrupted run by its run id, keeping completed outcomes.", { pattern: /^[A-Za-z0-9_.:+-]{1,80}$/ }),
  o("diff", "string", "run", "Diff against run", "Compare against a previous run id (or 'latest').", { pattern: /^[A-Za-z0-9_.:+-]{1,80}$/ }),
  o("fail-on-safety", "bool", "run", "Fail on safety", "Exit with status 2 when safety-critical scenarios fail."),

  // ── Scoring ──
  o("alpha", "float", "scoring", "Quality weight (alpha)", "Quality vs speed weight in the deployability score (0–1).", { min: 0, max: 1, default: 0.7 }),
  o("weight-by-difficulty", "bool", "scoring", "Weight by difficulty", "Score harder scenarios more (1× trivial … 5× very hard)."),

  // ── Output ──
  o("label", "string", "output", "Label", "Free-form note attached to every report from this run; a slug of it is added to report file names.", { maxLen: 120 }),
  o("output-dir", "path", "output", "Report directory", "Where report files are written on the Spark (default: the tool's own runs/ folder)."),

  // ── Throughput ──
  o("perf", "bool", "throughput", "Run throughput benchmark", "Run it before the tool-call scenarios."),
  o("perf-only", "bool", "throughput", "Throughput only", "Run only the throughput benchmark."),
  o("pp", "int", "throughput", "Prompt tokens", "Default 2048.", { min: 1, max: 4000000, default: 2048 }),
  o("tg", "int", "throughput", "Generation tokens", "Default 128.", { min: 1, max: 1000000, default: 128 }),
  o("depth", "csv", "throughput", "Context depths", "Comma separated, default 0,4096,8192.", { pattern: /^[0-9,]{1,100}$/, default: "0,4096,8192" }),
  o("concurrency", "csv", "throughput", "Concurrency levels", "Comma separated, default 1,2,4.", { pattern: /^[0-9,]{1,100}$/, default: "1,2,4" }),
  o("benchy-runs", "int", "throughput", "Runs per point", "Measurement runs per test point (default 3).", { min: 1, max: 100, default: 3 }),
  o("benchy-latency-mode", "choice", "throughput", "Latency mode", "How latency is measured (default: generation).", { choices: ["api", "generation", "none"], default: "generation" }),
  o("benchy-args", "string", "throughput", "Extra llama-benchy arguments", "Pass-through arguments for llama-benchy (one quoted string).", { maxLen: 500, pattern: /^[A-Za-z0-9_.,:=\/@+\- ]{1,500}$/ }),
  o("tokenizer", "path", "throughput", "Tokenizer path", "Local tokenizer.json (or its directory) for prompt construction. Needed only on offline hosts."),

  // ── Speculative decoding ──
  o("spec-bench", "bool", "spec", "Run speculative-decoding benchmark", "Effective tokens/s, acceptance rate and tau."),
  o("spec-method", "choice", "spec", "Method hint", "Used when the server does not identify its method (default: auto).", { choices: SPEC_METHODS, default: "auto" }),
  o("spec-prompts", "csv", "spec", "Prompt types", "Comma separated, default filler,code,structured. Labels from your prompt file also work.", { pattern: CSV, default: "filler,code,structured" }),
  o("spec-prompt-file", "path", "spec", "Custom prompt file", "One prompt per line, or JSON lines with 'prompt' and an optional 'label'."),
  o("spec-runs", "int", "spec", "Runs per cell", "Measurements per depth × prompt cell (default 3).", { min: 1, max: 100, default: 3 }),
  o("baseline-tgs", "float", "spec", "Baseline tokens/s", "Known tokens/s without speculation, for the speedup ratio.", { min: 0, max: 100000 }),
  o("metrics-url", "url", "spec", "Prometheus /metrics URL", "Needed when the API sits behind a proxy."),

  // ── Context pressure ──
  o("context-pressure", "float", "pressure", "Pressure ratio", "Fill the context to this ratio (0–1) before each scenario.", { min: 0, max: 1 }),
  o("context-pressure-sweep", "range", "pressure", "Pressure sweep", "From–to ratios such as 0.5-1.0.", { pattern: /^(0|1|0?\.\d+|1\.0+)-(0|1|0?\.\d+|1\.0+)$/ }),
  o("sweep-steps", "int", "pressure", "Sweep steps", "How many pressure levels to test (default 5).", { min: 2, max: 50, default: 5 }),
  o("context-size", "int", "pressure", "Context window override", "Tokens. Overrides the auto-detected window.", { min: 256, max: 100000000 }),

  // ── GSM8K ──
  o("gsm8k", "bool", "gsm8k", "Run GSM8K", "After the tool-call scenarios."),
  o("gsm8k-only", "bool", "gsm8k", "GSM8K only", "Skip the tool-call scenarios."),
  o("gsm8k-shots", "int", "gsm8k", "Few-shot examples", "0–8, default 8.", { min: 0, max: 8, default: 8 }),
  o("gsm8k-limit", "int", "gsm8k", "Question limit", "Default 200; 0 = all 1,319.", { min: 0, max: 100000, default: 200 }),
  o("gsm8k-shuffle", "bool", "gsm8k", "Shuffle questions", "Uses the seed for reproducibility."),

  // ── MMLU ──
  o("mmlu", "bool", "mmlu", "Run MMLU", "Multitask knowledge benchmark."),
  o("mmlu-only", "bool", "mmlu", "MMLU only", "Skip the tool-call scenarios."),
  o("mmlu-shots", "int", "mmlu", "Few-shot examples", "0–5, default 5.", { min: 0, max: 5, default: 5 }),
  o("mmlu-limit", "int", "mmlu", "Question limit", "Default 500; 0 = all 14,042.", { min: 0, max: 100000, default: 500 }),
  o("mmlu-subjects", "csv", "mmlu", "Subjects", "Comma-separated subjects or categories, e.g. STEM,abstract_algebra.", { pattern: CSV }),

  // ── IFEval ──
  o("ifeval", "bool", "ifeval", "Run IFEval", "Instruction-following benchmark."),
  o("ifeval-only", "bool", "ifeval", "IFEval only", "Skip the tool-call scenarios."),
  o("ifeval-limit", "int", "ifeval", "Prompt limit", "Default 0 = all 541.", { min: 0, max: 100000, default: 0 }),

  // ── Needle ──
  o("needle", "bool", "needle", "Run needle-in-a-haystack", "After the tool-call scenarios."),
  o("needle-only", "bool", "needle", "Needle only", "Skip the tool-call scenarios."),
  o("needle-depths", "int", "needle", "Depths", "Needle depths to probe, evenly spaced 0–100% (default 5).", { min: 1, max: 50, default: 5 }),
  o("needle-lengths", "int", "needle", "Lengths", "Haystack sizes up to the context window (default 4).", { min: 1, max: 50, default: 4 }),

  // ── Decision model ──
  o("decision", "bool", "decision", "Run decision-model benchmark", "llama.cpp /v1/systemone, after the tool-call scenarios."),
  o("decision-only", "bool", "decision", "Decision only", "Skip the tool-call scenarios and the chat pre-flight."),
];

const BY_NAME = new Map(ARG_SPEC.map((s) => [s.name, s]));

export function specByName(name) {
  return BY_NAME.get(name) ?? null;
}

/** JSON-safe copy for the UI (RegExp → source string). */
export function publicSpec() {
  const strip = (s) => ({
    ...s,
    pattern: s.pattern ? s.pattern.source : undefined,
    itemPattern: s.itemPattern ? s.itemPattern.source : undefined,
  });
  return { groups: GROUPS, args: ARG_SPEC.map(strip), backends: BACKENDS, categories: CATEGORY_LETTERS };
}
