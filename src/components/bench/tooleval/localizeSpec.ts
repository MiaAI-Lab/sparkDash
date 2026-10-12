import type { TFunction } from "i18next";
import type { ToolEvalArgSpec, ToolEvalSpec } from "../../../api/types";

/* The server remains the schema authority. This projection only replaces prose by
 * stable ids, so translated labels never change CLI flags, choices, or validation. */
function groupText(id: string, field: "label" | "help", fallback: string, t: TFunction): string {
  switch (id) {
    case "connection": return field === "label" ? t("bench.groups.connection.label", "Connection") : t("bench.groups.connection.help", "Which model endpoint to test and how to talk to it.");
    case "scenarios": return field === "label" ? t("bench.groups.scenarios.label", "Scenarios") : t("bench.groups.scenarios.help", "Which tool-calling scenarios run.");
    case "sampling": return field === "label" ? t("bench.groups.sampling.label", "Sampling") : t("bench.groups.sampling.help", "How the model generates its answers.");
    case "run": return field === "label" ? t("bench.groups.run.label", "Run control") : t("bench.groups.run.help", "Timeouts, repetitions, concurrency and prompt overrides.");
    case "scoring": return field === "label" ? t("bench.groups.scoring.label", "Scoring") : t("bench.groups.scoring.help", "How the score is weighted.");
    case "output": return field === "label" ? t("bench.groups.output.label", "Output") : t("bench.groups.output.help", "Labels and where reports are written.");
    case "throughput": return field === "label" ? t("bench.groups.throughput.label", "Throughput benchmark") : t("bench.groups.throughput.help", "Prompt processing and generation speed (llama-benchy style).");
    case "spec": return field === "label" ? t("bench.groups.spec.label", "Speculative decoding") : t("bench.groups.spec.help", "Effective tokens/s and draft acceptance for speculative / MTP decoding.");
    case "pressure": return field === "label" ? t("bench.groups.pressure.label", "Context pressure") : t("bench.groups.pressure.help", "Fill the context window before each scenario to find where quality degrades.");
    case "gsm8k": return field === "label" ? t("bench.groups.gsm8k.label", "GSM8K (math)") : t("bench.groups.gsm8k.help", "Grade-school math reasoning.");
    case "mmlu": return field === "label" ? t("bench.groups.mmlu.label", "MMLU (knowledge)") : t("bench.groups.mmlu.help", "Multitask knowledge benchmark.");
    case "ifeval": return field === "label" ? t("bench.groups.ifeval.label", "IFEval (instructions)") : t("bench.groups.ifeval.help", "Instruction-following with verifiable constraints.");
    case "needle": return field === "label" ? t("bench.groups.needle.label", "Needle in a haystack") : t("bench.groups.needle.help", "Long-context retrieval at different depths and lengths.");
    case "decision": return field === "label" ? t("bench.groups.decision.label", "Decision model") : t("bench.groups.decision.help", "Decision-model scoring on a llama.cpp /v1/systemone endpoint.");
    case "advanced": return field === "label" ? t("bench.groups.advanced.label", "Advanced") : t("bench.groups.advanced.help", "Mode switches and one-off tweaks.");
    default: return fallback;
  }
}

function argText(arg: ToolEvalArgSpec, field: "label" | "help", t: TFunction): string {
  switch (arg.name) {
    case "base-url": return field === "label" ? t("bench.args.base-url.label", "Base URL") : t("bench.args.base-url.help", "OpenAI-compatible server URL. Empty = this Spark's LLM port on localhost (the run happens on the Spark itself).");
    case "model": return field === "label" ? t("bench.args.model.label", "Model") : t("bench.args.model.help", "Model name or path. Empty = auto-detected from the server.");
    case "backend": return field === "label" ? t("bench.args.backend.label", "Backend label") : t("bench.args.backend.help", "Label for reports only; the request format follows the endpoint, not this label.");
    case "provider": return field === "label" ? t("bench.args.provider.label", "Provider") : t("bench.args.provider.help", "Read the endpoint from TOOL_EVAL_<NAME>_BASE_URL / _API_KEY / _MODEL set on the Spark (e.g. openai, gemini, anthropic).");
    case "format": return field === "label" ? t("bench.args.format.label", "Wire format") : t("bench.args.format.help", "openai, gemini or anthropic (/v1/messages). Default: detected from the base URL.");
    case "api-key": return field === "label" ? t("bench.args.api-key.label", "API key") : t("bench.args.api-key.help", "Sent to the tool through its environment, never on a command line. Leave empty to use the key saved for this Spark's port (if any).");
    case "header": return field === "label" ? t("bench.args.header.label", "Extra request headers") : t("bench.args.header.help", "One NAME=VALUE per line. Values are passed through the environment (they may hold tokens). Semicolons are not allowed in values.");
    case "session-header": return field === "label" ? t("bench.args.session-header.label", "Session header") : t("bench.args.session-header.help", "Header carrying a per-conversation id, e.g. x-opencode-session.");
    case "short": return field === "label" ? t("bench.args.short.label", "Short run (core 15)") : t("bench.args.short.help", "Run only the 15 core scenarios (about 2 minutes). Skips the extended and agentic ones.");
    case "scenarios": return field === "label" ? t("bench.args.scenarios.label", "Specific scenarios") : t("bench.args.scenarios.help", "Scenario IDs such as TC-01 TC-07. Empty = all.");
    case "categories": return field === "label" ? t("bench.args.categories.label", "Categories") : t("bench.args.categories.help", "Run only these categories (letters A–P). Empty = all.");
    case "hardmode": return field === "label" ? t("bench.args.hardmode.label", "Include Hard Mode") : t("bench.args.hardmode.help", "Add the Hard Mode scenarios (category P): adversarial, stateful, transactional.");
    case "hardmode-only": return field === "label" ? t("bench.args.hardmode-only.label", "Hard Mode only") : t("bench.args.hardmode-only.help", "Run only Hard Mode scenarios (shortcut for --hardmode --categories P).");
    case "variant-seed": return field === "label" ? t("bench.args.variant-seed.label", "Variant seed") : t("bench.args.variant-seed.help", "Use versioned deterministic fixture variants; unchanged scenarios stay as controls.");
    case "scenario-pack": return field === "label" ? t("bench.args.scenario-pack.label", "Held-out scenario packs") : t("bench.args.scenario-pack.help", "Directory of a YAML scenario pack on the Spark, one per line. Pack prompts are withheld from reports.");
    case "pack-only": return field === "label" ? t("bench.args.pack-only.label", "Packs only") : t("bench.args.pack-only.help", "Run only the scenarios from the packs above (skip the public suite).");
    case "temperature": return field === "label" ? t("bench.args.temperature.label", "Temperature") : t("bench.args.temperature.help", "Default 0.0 (greedy).");
    case "no-think": return field === "label" ? t("bench.args.no-think.label", "Disable thinking") : t("bench.args.no-think.help", "Turns off thinking/reasoning (enable_thinking=false). Important for Qwen3 and DeepSeek style models.");
    case "top-p": return field === "label" ? t("bench.args.top-p.label", "Top-p") : t("bench.args.top-p.help", "Nucleus sampling, e.g. 0.9.");
    case "top-k": return field === "label" ? t("bench.args.top-k.label", "Top-k") : t("bench.args.top-k.help", "e.g. 40.");
    case "min-p": return field === "label" ? t("bench.args.min-p.label", "Min-p") : t("bench.args.min-p.help", "Min-p threshold, e.g. 0.05.");
    case "repeat-penalty": return field === "label" ? t("bench.args.repeat-penalty.label", "Repeat penalty") : t("bench.args.repeat-penalty.help", "e.g. 1.1.");
    case "seed": return field === "label" ? t("bench.args.seed.label", "Seed") : t("bench.args.seed.help", "Random seed passed to the server for reproducible sampling.");
    case "backend-kwargs": return field === "label" ? t("bench.args.backend-kwargs.label", "Backend kwargs (JSON)") : t("bench.args.backend-kwargs.help", "A JSON object merged into every API payload; overrides the individual sampling fields.");
    case "timeout": return field === "label" ? t("bench.args.timeout.label", "Request timeout (s)") : t("bench.args.timeout.help", "Per-request timeout. Thinking models may need 120 or more.");
    case "max-turns": return field === "label" ? t("bench.args.max-turns.label", "Max turns per scenario") : t("bench.args.max-turns.help", "Default 8.");
    case "trials": return field === "label" ? t("bench.args.trials.label", "Trials") : t("bench.args.trials.help", "Repeat the whole run N times for Pass@k statistics.");
    case "parallel": return field === "label" ? t("bench.args.parallel.label", "Parallel scenarios") : t("bench.args.parallel.help", "Run N scenarios concurrently (1 = sequential).");
    case "error-rate": return field === "label" ? t("bench.args.error-rate.label", "Injected tool-error rate") : t("bench.args.error-rate.help", "Randomly inject tool errors (0–1) to test robustness.");
    case "no-warmup": return field === "label" ? t("bench.args.no-warmup.label", "Skip warm-up") : t("bench.args.no-warmup.help", "Do not send the warm-up request first.");
    case "no-preflight": return field === "label" ? t("bench.args.no-preflight.label", "Skip model pre-flight") : t("bench.args.no-preflight.help", "Skip the strict model availability check.");
    case "no-probe-engine": return field === "label" ? t("bench.args.no-probe-engine.label", "Skip engine probing") : t("bench.args.no-probe-engine.help", "No /version or /health calls to identify the inference engine.");
    case "reference-date": return field === "label" ? t("bench.args.reference-date.label", "Reference date") : t("bench.args.reference-date.help", "Override the benchmark's reference date (YYYY-MM-DD).");
    case "system-prompt": return field === "label" ? t("bench.args.system-prompt.label", "System prompt override") : t("bench.args.system-prompt.help", "Replaces the built-in prompt for every scenario (max 32 KiB). Part of the run fingerprint.");
    case "system-prompt-file": return field === "label" ? t("bench.args.system-prompt-file.label", "System prompt file") : t("bench.args.system-prompt-file.help", "Path on the Spark to a UTF-8 file (max 32 KiB). Cannot be combined with the text above.");
    case "skip-tool-eval": return field === "label" ? t("bench.args.skip-tool-eval.label", "Skip tool-call scenarios") : t("bench.args.skip-tool-eval.help", "Use together with throughput or speculative-decoding benchmarks.");
    case "resume": return field === "label" ? t("bench.args.resume.label", "Resume run") : t("bench.args.resume.help", "Continue an interrupted run by its run id, keeping completed outcomes.");
    case "diff": return field === "label" ? t("bench.args.diff.label", "Diff against run") : t("bench.args.diff.help", "Compare against a previous run id (or 'latest').");
    case "fail-on-safety": return field === "label" ? t("bench.args.fail-on-safety.label", "Fail on safety") : t("bench.args.fail-on-safety.help", "Exit with status 2 when safety-critical scenarios fail.");
    case "alpha": return field === "label" ? t("bench.args.alpha.label", "Quality weight (alpha)") : t("bench.args.alpha.help", "Quality vs speed weight in the deployability score (0–1).");
    case "weight-by-difficulty": return field === "label" ? t("bench.args.weight-by-difficulty.label", "Weight by difficulty") : t("bench.args.weight-by-difficulty.help", "Score harder scenarios more (1× trivial … 5× very hard).");
    case "label": return field === "label" ? t("bench.args.label.label", "Label") : t("bench.args.label.help", "Free-form note attached to every report from this run; a slug of it is added to report file names.");
    case "output-dir": return field === "label" ? t("bench.args.output-dir.label", "Report directory") : t("bench.args.output-dir.help", "Where report files are written on the Spark (default: the tool's own runs/ folder).");
    case "perf": return field === "label" ? t("bench.args.perf.label", "Run throughput benchmark") : t("bench.args.perf.help", "Run it before the tool-call scenarios.");
    case "perf-only": return field === "label" ? t("bench.args.perf-only.label", "Throughput only") : t("bench.args.perf-only.help", "Run only the throughput benchmark.");
    case "pp": return field === "label" ? t("bench.args.pp.label", "Prompt tokens") : t("bench.args.pp.help", "Default 2048.");
    case "tg": return field === "label" ? t("bench.args.tg.label", "Generation tokens") : t("bench.args.tg.help", "Default 128.");
    case "depth": return field === "label" ? t("bench.args.depth.label", "Context depths") : t("bench.args.depth.help", "Comma separated, default 0,4096,8192.");
    case "concurrency": return field === "label" ? t("bench.args.concurrency.label", "Concurrency levels") : t("bench.args.concurrency.help", "Comma separated, default 1,2,4.");
    case "benchy-runs": return field === "label" ? t("bench.args.benchy-runs.label", "Runs per point") : t("bench.args.benchy-runs.help", "Measurement runs per test point (default 3).");
    case "benchy-latency-mode": return field === "label" ? t("bench.args.benchy-latency-mode.label", "Latency mode") : t("bench.args.benchy-latency-mode.help", "How latency is measured (default: generation).");
    case "benchy-args": return field === "label" ? t("bench.args.benchy-args.label", "Extra llama-benchy arguments") : t("bench.args.benchy-args.help", "Pass-through arguments for llama-benchy (one quoted string).");
    case "tokenizer": return field === "label" ? t("bench.args.tokenizer.label", "Tokenizer path") : t("bench.args.tokenizer.help", "Local tokenizer.json (or its directory) for prompt construction. Needed only on offline hosts.");
    case "spec-bench": return field === "label" ? t("bench.args.spec-bench.label", "Run speculative-decoding benchmark") : t("bench.args.spec-bench.help", "Effective tokens/s, acceptance rate and tau.");
    case "spec-method": return field === "label" ? t("bench.args.spec-method.label", "Method hint") : t("bench.args.spec-method.help", "Used when the server does not identify its method (default: auto).");
    case "spec-prompts": return field === "label" ? t("bench.args.spec-prompts.label", "Prompt types") : t("bench.args.spec-prompts.help", "Comma separated, default filler,code,structured. Labels from your prompt file also work.");
    case "spec-prompt-file": return field === "label" ? t("bench.args.spec-prompt-file.label", "Custom prompt file") : t("bench.args.spec-prompt-file.help", "One prompt per line, or JSON lines with 'prompt' and an optional 'label'.");
    case "spec-runs": return field === "label" ? t("bench.args.spec-runs.label", "Runs per cell") : t("bench.args.spec-runs.help", "Measurements per depth × prompt cell (default 3).");
    case "baseline-tgs": return field === "label" ? t("bench.args.baseline-tgs.label", "Baseline tokens/s") : t("bench.args.baseline-tgs.help", "Known tokens/s without speculation, for the speedup ratio.");
    case "metrics-url": return field === "label" ? t("bench.args.metrics-url.label", "Prometheus /metrics URL") : t("bench.args.metrics-url.help", "Needed when the API sits behind a proxy.");
    case "context-pressure": return field === "label" ? t("bench.args.context-pressure.label", "Pressure ratio") : t("bench.args.context-pressure.help", "Fill the context to this ratio (0–1) before each scenario.");
    case "context-pressure-sweep": return field === "label" ? t("bench.args.context-pressure-sweep.label", "Pressure sweep") : t("bench.args.context-pressure-sweep.help", "From–to ratios such as 0.5-1.0.");
    case "sweep-steps": return field === "label" ? t("bench.args.sweep-steps.label", "Sweep steps") : t("bench.args.sweep-steps.help", "How many pressure levels to test (default 5).");
    case "context-size": return field === "label" ? t("bench.args.context-size.label", "Context window override") : t("bench.args.context-size.help", "Tokens. Overrides the auto-detected window.");
    case "gsm8k": return field === "label" ? t("bench.args.gsm8k.label", "Run GSM8K") : t("bench.args.gsm8k.help", "After the tool-call scenarios.");
    case "gsm8k-only": return field === "label" ? t("bench.args.gsm8k-only.label", "GSM8K only") : t("bench.args.gsm8k-only.help", "Skip the tool-call scenarios.");
    case "gsm8k-shots": return field === "label" ? t("bench.args.gsm8k-shots.label", "Few-shot examples") : t("bench.args.gsm8k-shots.help", "0–8, default 8.");
    case "gsm8k-limit": return field === "label" ? t("bench.args.gsm8k-limit.label", "Question limit") : t("bench.args.gsm8k-limit.help", "Default 200; 0 = all 1,319.");
    case "gsm8k-shuffle": return field === "label" ? t("bench.args.gsm8k-shuffle.label", "Shuffle questions") : t("bench.args.gsm8k-shuffle.help", "Uses the seed for reproducibility.");
    case "mmlu": return field === "label" ? t("bench.args.mmlu.label", "Run MMLU") : t("bench.args.mmlu.help", "Multitask knowledge benchmark.");
    case "mmlu-only": return field === "label" ? t("bench.args.mmlu-only.label", "MMLU only") : t("bench.args.mmlu-only.help", "Skip the tool-call scenarios.");
    case "mmlu-shots": return field === "label" ? t("bench.args.mmlu-shots.label", "Few-shot examples") : t("bench.args.mmlu-shots.help", "0–5, default 5.");
    case "mmlu-limit": return field === "label" ? t("bench.args.mmlu-limit.label", "Question limit") : t("bench.args.mmlu-limit.help", "Default 500; 0 = all 14,042.");
    case "mmlu-subjects": return field === "label" ? t("bench.args.mmlu-subjects.label", "Subjects") : t("bench.args.mmlu-subjects.help", "Comma-separated subjects or categories, e.g. STEM,abstract_algebra.");
    case "ifeval": return field === "label" ? t("bench.args.ifeval.label", "Run IFEval") : t("bench.args.ifeval.help", "Instruction-following benchmark.");
    case "ifeval-only": return field === "label" ? t("bench.args.ifeval-only.label", "IFEval only") : t("bench.args.ifeval-only.help", "Skip the tool-call scenarios.");
    case "ifeval-limit": return field === "label" ? t("bench.args.ifeval-limit.label", "Prompt limit") : t("bench.args.ifeval-limit.help", "Default 0 = all 541.");
    case "needle": return field === "label" ? t("bench.args.needle.label", "Run needle-in-a-haystack") : t("bench.args.needle.help", "After the tool-call scenarios.");
    case "needle-only": return field === "label" ? t("bench.args.needle-only.label", "Needle only") : t("bench.args.needle-only.help", "Skip the tool-call scenarios.");
    case "needle-depths": return field === "label" ? t("bench.args.needle-depths.label", "Depths") : t("bench.args.needle-depths.help", "Needle depths to probe, evenly spaced 0–100% (default 5).");
    case "needle-lengths": return field === "label" ? t("bench.args.needle-lengths.label", "Lengths") : t("bench.args.needle-lengths.help", "Haystack sizes up to the context window (default 4).");
    case "decision": return field === "label" ? t("bench.args.decision.label", "Run decision-model benchmark") : t("bench.args.decision.help", "llama.cpp /v1/systemone, after the tool-call scenarios.");
    case "decision-only": return field === "label" ? t("bench.args.decision-only.label", "Decision only") : t("bench.args.decision-only.help", "Skip the tool-call scenarios and the chat pre-flight.");
    default: return field === "label" ? arg.label : arg.help;
  }
}

export function localizeToolEvalSpec(spec: ToolEvalSpec, t: TFunction): ToolEvalSpec {
  return {
    ...spec,
    groups: spec.groups.map((group) => ({ ...group, label: groupText(group.id, "label", group.label, t), help: groupText(group.id, "help", group.help, t) })),
    args: spec.args.map((arg) => ({ ...arg, label: argText(arg, "label", t), help: argText(arg, "help", t) })),
  };
}
