import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ToolEvalSpec } from "../../../api/types";

/** Known option IDs have catalog copy; unknown future options remain readable verbatim. */
export function useToolEvalSpecLabels(spec: ToolEvalSpec | null): ToolEvalSpec | null {
  const { t } = useTranslation("tooleval");
  return useMemo(() => {
    if (!spec) return null;
    const args: Record<string, { label: string; help: string }> = {
      "base-url": { label: t("metadata.args.base-url.label"), help: t("metadata.args.base-url.help") },
      "model": { label: t("metadata.args.model.label"), help: t("metadata.args.model.help") },
      "backend": { label: t("metadata.args.backend.label"), help: t("metadata.args.backend.help") },
      "provider": { label: t("metadata.args.provider.label"), help: t("metadata.args.provider.help") },
      "format": { label: t("metadata.args.format.label"), help: t("metadata.args.format.help") },
      "api-key": { label: t("metadata.args.api-key.label"), help: t("metadata.args.api-key.help") },
      "header": { label: t("metadata.args.header.label"), help: t("metadata.args.header.help") },
      "session-header": { label: t("metadata.args.session-header.label"), help: t("metadata.args.session-header.help") },
      "short": { label: t("metadata.args.short.label"), help: t("metadata.args.short.help") },
      "scenarios": { label: t("metadata.args.scenarios.label"), help: t("metadata.args.scenarios.help") },
      "categories": { label: t("metadata.args.categories.label"), help: t("metadata.args.categories.help") },
      "hardmode": { label: t("metadata.args.hardmode.label"), help: t("metadata.args.hardmode.help") },
      "hardmode-only": { label: t("metadata.args.hardmode-only.label"), help: t("metadata.args.hardmode-only.help") },
      "variant-seed": { label: t("metadata.args.variant-seed.label"), help: t("metadata.args.variant-seed.help") },
      "scenario-pack": { label: t("metadata.args.scenario-pack.label"), help: t("metadata.args.scenario-pack.help") },
      "pack-only": { label: t("metadata.args.pack-only.label"), help: t("metadata.args.pack-only.help") },
      "temperature": { label: t("metadata.args.temperature.label"), help: t("metadata.args.temperature.help") },
      "no-think": { label: t("metadata.args.no-think.label"), help: t("metadata.args.no-think.help") },
      "top-p": { label: t("metadata.args.top-p.label"), help: t("metadata.args.top-p.help") },
      "top-k": { label: t("metadata.args.top-k.label"), help: t("metadata.args.top-k.help") },
      "min-p": { label: t("metadata.args.min-p.label"), help: t("metadata.args.min-p.help") },
      "repeat-penalty": { label: t("metadata.args.repeat-penalty.label"), help: t("metadata.args.repeat-penalty.help") },
      "seed": { label: t("metadata.args.seed.label"), help: t("metadata.args.seed.help") },
      "backend-kwargs": { label: t("metadata.args.backend-kwargs.label"), help: t("metadata.args.backend-kwargs.help") },
      "timeout": { label: t("metadata.args.timeout.label"), help: t("metadata.args.timeout.help") },
      "max-turns": { label: t("metadata.args.max-turns.label"), help: t("metadata.args.max-turns.help") },
      "trials": { label: t("metadata.args.trials.label"), help: t("metadata.args.trials.help") },
      "parallel": { label: t("metadata.args.parallel.label"), help: t("metadata.args.parallel.help") },
      "error-rate": { label: t("metadata.args.error-rate.label"), help: t("metadata.args.error-rate.help") },
      "no-warmup": { label: t("metadata.args.no-warmup.label"), help: t("metadata.args.no-warmup.help") },
      "no-preflight": { label: t("metadata.args.no-preflight.label"), help: t("metadata.args.no-preflight.help") },
      "no-probe-engine": { label: t("metadata.args.no-probe-engine.label"), help: t("metadata.args.no-probe-engine.help") },
      "reference-date": { label: t("metadata.args.reference-date.label"), help: t("metadata.args.reference-date.help") },
      "system-prompt": { label: t("metadata.args.system-prompt.label"), help: t("metadata.args.system-prompt.help") },
      "system-prompt-file": { label: t("metadata.args.system-prompt-file.label"), help: t("metadata.args.system-prompt-file.help") },
      "skip-tool-eval": { label: t("metadata.args.skip-tool-eval.label"), help: t("metadata.args.skip-tool-eval.help") },
      "resume": { label: t("metadata.args.resume.label"), help: t("metadata.args.resume.help") },
      "diff": { label: t("metadata.args.diff.label"), help: t("metadata.args.diff.help") },
      "fail-on-safety": { label: t("metadata.args.fail-on-safety.label"), help: t("metadata.args.fail-on-safety.help") },
      "alpha": { label: t("metadata.args.alpha.label"), help: t("metadata.args.alpha.help") },
      "weight-by-difficulty": { label: t("metadata.args.weight-by-difficulty.label"), help: t("metadata.args.weight-by-difficulty.help") },
      "label": { label: t("metadata.args.label.label"), help: t("metadata.args.label.help") },
      "output-dir": { label: t("metadata.args.output-dir.label"), help: t("metadata.args.output-dir.help") },
      "perf": { label: t("metadata.args.perf.label"), help: t("metadata.args.perf.help") },
      "perf-only": { label: t("metadata.args.perf-only.label"), help: t("metadata.args.perf-only.help") },
      "pp": { label: t("metadata.args.pp.label"), help: t("metadata.args.pp.help") },
      "tg": { label: t("metadata.args.tg.label"), help: t("metadata.args.tg.help") },
      "depth": { label: t("metadata.args.depth.label"), help: t("metadata.args.depth.help") },
      "concurrency": { label: t("metadata.args.concurrency.label"), help: t("metadata.args.concurrency.help") },
      "benchy-runs": { label: t("metadata.args.benchy-runs.label"), help: t("metadata.args.benchy-runs.help") },
      "benchy-latency-mode": { label: t("metadata.args.benchy-latency-mode.label"), help: t("metadata.args.benchy-latency-mode.help") },
      "benchy-args": { label: t("metadata.args.benchy-args.label"), help: t("metadata.args.benchy-args.help") },
      "tokenizer": { label: t("metadata.args.tokenizer.label"), help: t("metadata.args.tokenizer.help") },
      "spec-bench": { label: t("metadata.args.spec-bench.label"), help: t("metadata.args.spec-bench.help") },
      "spec-method": { label: t("metadata.args.spec-method.label"), help: t("metadata.args.spec-method.help") },
      "spec-prompts": { label: t("metadata.args.spec-prompts.label"), help: t("metadata.args.spec-prompts.help") },
      "spec-prompt-file": { label: t("metadata.args.spec-prompt-file.label"), help: t("metadata.args.spec-prompt-file.help") },
      "spec-runs": { label: t("metadata.args.spec-runs.label"), help: t("metadata.args.spec-runs.help") },
      "baseline-tgs": { label: t("metadata.args.baseline-tgs.label"), help: t("metadata.args.baseline-tgs.help") },
      "metrics-url": { label: t("metadata.args.metrics-url.label"), help: t("metadata.args.metrics-url.help") },
      "context-pressure": { label: t("metadata.args.context-pressure.label"), help: t("metadata.args.context-pressure.help") },
      "context-pressure-sweep": { label: t("metadata.args.context-pressure-sweep.label"), help: t("metadata.args.context-pressure-sweep.help") },
      "sweep-steps": { label: t("metadata.args.sweep-steps.label"), help: t("metadata.args.sweep-steps.help") },
      "context-size": { label: t("metadata.args.context-size.label"), help: t("metadata.args.context-size.help") },
      "gsm8k": { label: t("metadata.args.gsm8k.label"), help: t("metadata.args.gsm8k.help") },
      "gsm8k-only": { label: t("metadata.args.gsm8k-only.label"), help: t("metadata.args.gsm8k-only.help") },
      "gsm8k-shots": { label: t("metadata.args.gsm8k-shots.label"), help: t("metadata.args.gsm8k-shots.help") },
      "gsm8k-limit": { label: t("metadata.args.gsm8k-limit.label"), help: t("metadata.args.gsm8k-limit.help") },
      "gsm8k-shuffle": { label: t("metadata.args.gsm8k-shuffle.label"), help: t("metadata.args.gsm8k-shuffle.help") },
      "mmlu": { label: t("metadata.args.mmlu.label"), help: t("metadata.args.mmlu.help") },
      "mmlu-only": { label: t("metadata.args.mmlu-only.label"), help: t("metadata.args.mmlu-only.help") },
      "mmlu-shots": { label: t("metadata.args.mmlu-shots.label"), help: t("metadata.args.mmlu-shots.help") },
      "mmlu-limit": { label: t("metadata.args.mmlu-limit.label"), help: t("metadata.args.mmlu-limit.help") },
      "mmlu-subjects": { label: t("metadata.args.mmlu-subjects.label"), help: t("metadata.args.mmlu-subjects.help") },
      "ifeval": { label: t("metadata.args.ifeval.label"), help: t("metadata.args.ifeval.help") },
      "ifeval-only": { label: t("metadata.args.ifeval-only.label"), help: t("metadata.args.ifeval-only.help") },
      "ifeval-limit": { label: t("metadata.args.ifeval-limit.label"), help: t("metadata.args.ifeval-limit.help") },
      "needle": { label: t("metadata.args.needle.label"), help: t("metadata.args.needle.help") },
      "needle-only": { label: t("metadata.args.needle-only.label"), help: t("metadata.args.needle-only.help") },
      "needle-depths": { label: t("metadata.args.needle-depths.label"), help: t("metadata.args.needle-depths.help") },
      "needle-lengths": { label: t("metadata.args.needle-lengths.label"), help: t("metadata.args.needle-lengths.help") },
      "decision": { label: t("metadata.args.decision.label"), help: t("metadata.args.decision.help") },
      "decision-only": { label: t("metadata.args.decision-only.label"), help: t("metadata.args.decision-only.help") },
    };
    const groups: Record<string, { label: string; help: string }> = {
      "connection": { label: t("metadata.groups.connection.label"), help: t("metadata.groups.connection.help") },
      "scenarios": { label: t("metadata.groups.scenarios.label"), help: t("metadata.groups.scenarios.help") },
      "sampling": { label: t("metadata.groups.sampling.label"), help: t("metadata.groups.sampling.help") },
      "run": { label: t("metadata.groups.run.label"), help: t("metadata.groups.run.help") },
      "scoring": { label: t("metadata.groups.scoring.label"), help: t("metadata.groups.scoring.help") },
      "output": { label: t("metadata.groups.output.label"), help: t("metadata.groups.output.help") },
      "throughput": { label: t("metadata.groups.throughput.label"), help: t("metadata.groups.throughput.help") },
      "spec": { label: t("metadata.groups.spec.label"), help: t("metadata.groups.spec.help") },
      "pressure": { label: t("metadata.groups.pressure.label"), help: t("metadata.groups.pressure.help") },
      "gsm8k": { label: t("metadata.groups.gsm8k.label"), help: t("metadata.groups.gsm8k.help") },
      "mmlu": { label: t("metadata.groups.mmlu.label"), help: t("metadata.groups.mmlu.help") },
      "ifeval": { label: t("metadata.groups.ifeval.label"), help: t("metadata.groups.ifeval.help") },
      "needle": { label: t("metadata.groups.needle.label"), help: t("metadata.groups.needle.help") },
      "decision": { label: t("metadata.groups.decision.label"), help: t("metadata.groups.decision.help") },
      "advanced": { label: t("metadata.groups.advanced.label"), help: t("metadata.groups.advanced.help") },
    };
    return { ...spec, args: spec.args.map((arg) => ({ ...arg, ...args[arg.name] })), groups: spec.groups.map((group) => ({ ...group, ...groups[group.id] })) };
  }, [spec, t]);
}

export function useToolEvalPresetLabels() {
  const { t } = useTranslation("tooleval");
  return useMemo(() => {
    const presets: Record<string, Record<string, { label: string; help: string; size?: string; time?: string }>> = {
      "tool-eval": {
        "quick": { label: t("metadata.presets.tool-eval.quick.label"), help: t("metadata.presets.tool-eval.quick.help") },
        "full": { label: t("metadata.presets.tool-eval.full.label"), help: t("metadata.presets.tool-eval.full.help") },
        "hard": { label: t("metadata.presets.tool-eval.hard.label"), help: t("metadata.presets.tool-eval.hard.help") },
        "repro": { label: t("metadata.presets.tool-eval.repro.label"), help: t("metadata.presets.tool-eval.repro.help") },
        "thinking": { label: t("metadata.presets.tool-eval.thinking.label"), help: t("metadata.presets.tool-eval.thinking.help") },
      },
      "throughput": {
        "quick": { label: t("metadata.presets.throughput.quick.label"), help: t("metadata.presets.throughput.quick.help") },
        "standard": { label: t("metadata.presets.throughput.standard.label"), help: t("metadata.presets.throughput.standard.help") },
        "deep": { label: t("metadata.presets.throughput.deep.label"), help: t("metadata.presets.throughput.deep.help") },
      },
      "spec-decode": {
        "quick": { label: t("metadata.presets.spec-decode.quick.label"), help: t("metadata.presets.spec-decode.quick.help") },
        "standard": { label: t("metadata.presets.spec-decode.standard.label"), help: t("metadata.presets.spec-decode.standard.help") },
        "code": { label: t("metadata.presets.spec-decode.code.label"), help: t("metadata.presets.spec-decode.code.help") },
      },
      "context-pressure": {
        "single": { label: t("metadata.presets.context-pressure.single.label"), help: t("metadata.presets.context-pressure.single.help") },
        "sweep": { label: t("metadata.presets.context-pressure.sweep.label"), help: t("metadata.presets.context-pressure.sweep.help") },
        "fine": { label: t("metadata.presets.context-pressure.fine.label"), help: t("metadata.presets.context-pressure.fine.help") },
      },
      "accuracy": {
        "quick": { label: t("metadata.presets.accuracy.quick.label"), help: t("metadata.presets.accuracy.quick.help") },
        "standard": { label: t("metadata.presets.accuracy.standard.label"), help: t("metadata.presets.accuracy.standard.help") },
        "full": { label: t("metadata.presets.accuracy.full.label"), help: t("metadata.presets.accuracy.full.help") },
        "repro": { label: t("metadata.presets.accuracy.repro.label"), help: t("metadata.presets.accuracy.repro.help") },
      },
      "needle": {
        "quick": { label: t("metadata.presets.needle.quick.label"), help: t("metadata.presets.needle.quick.help") },
        "standard": { label: t("metadata.presets.needle.standard.label"), help: t("metadata.presets.needle.standard.help") },
        "thorough": { label: t("metadata.presets.needle.thorough.label"), help: t("metadata.presets.needle.thorough.help") },
      },
      "decision": {
        "standard": { label: t("metadata.presets.decision.standard.label"), help: t("metadata.presets.decision.standard.help") },
      },
    };
    const simple: Record<string, Record<string, { label: string; help: string; size?: string; time?: string }>> = {
      "tool-eval": {
        "regular": { label: t("metadata.simple.tool-eval.regular.label"), help: t("metadata.simple.tool-eval.regular.help"), size: t("metadata.simple.tool-eval.regular.size"), time: t("metadata.simple.tool-eval.regular.time") },
        "regular-hard": { label: t("metadata.simple.tool-eval.regular-hard.label"), help: t("metadata.simple.tool-eval.regular-hard.help"), size: t("metadata.simple.tool-eval.regular-hard.size"), time: t("metadata.simple.tool-eval.regular-hard.time") },
        "short": { label: t("metadata.simple.tool-eval.short.label"), help: t("metadata.simple.tool-eval.short.help"), size: t("metadata.simple.tool-eval.short.size"), time: t("metadata.simple.tool-eval.short.time") },
        "hard": { label: t("metadata.simple.tool-eval.hard.label"), help: t("metadata.simple.tool-eval.hard.help"), size: t("metadata.simple.tool-eval.hard.size"), time: t("metadata.simple.tool-eval.hard.time") },
      },
      "throughput": {
        "quick": { label: t("metadata.simple.throughput.quick.label"), help: t("metadata.simple.throughput.quick.help") },
        "standard": { label: t("metadata.simple.throughput.standard.label"), help: t("metadata.simple.throughput.standard.help") },
        "deep": { label: t("metadata.simple.throughput.deep.label"), help: t("metadata.simple.throughput.deep.help") },
      },
      "spec-decode": {
        "quick": { label: t("metadata.simple.spec-decode.quick.label"), help: t("metadata.simple.spec-decode.quick.help") },
        "standard": { label: t("metadata.simple.spec-decode.standard.label"), help: t("metadata.simple.spec-decode.standard.help") },
        "code": { label: t("metadata.simple.spec-decode.code.label"), help: t("metadata.simple.spec-decode.code.help") },
      },
      "context-pressure": {
        "single": { label: t("metadata.simple.context-pressure.single.label"), help: t("metadata.simple.context-pressure.single.help") },
        "sweep": { label: t("metadata.simple.context-pressure.sweep.label"), help: t("metadata.simple.context-pressure.sweep.help") },
        "fine": { label: t("metadata.simple.context-pressure.fine.label"), help: t("metadata.simple.context-pressure.fine.help") },
      },
      "accuracy": {
        "quick": { label: t("metadata.simple.accuracy.quick.label"), help: t("metadata.simple.accuracy.quick.help") },
        "standard": { label: t("metadata.simple.accuracy.standard.label"), help: t("metadata.simple.accuracy.standard.help") },
        "full": { label: t("metadata.simple.accuracy.full.label"), help: t("metadata.simple.accuracy.full.help") },
        "repro": { label: t("metadata.simple.accuracy.repro.label"), help: t("metadata.simple.accuracy.repro.help") },
      },
      "needle": {
        "quick": { label: t("metadata.simple.needle.quick.label"), help: t("metadata.simple.needle.quick.help") },
        "standard": { label: t("metadata.simple.needle.standard.label"), help: t("metadata.simple.needle.standard.help") },
        "thorough": { label: t("metadata.simple.needle.thorough.label"), help: t("metadata.simple.needle.thorough.help") },
      },
      "decision": {
        "standard": { label: t("metadata.simple.decision.standard.label"), help: t("metadata.simple.decision.standard.help") },
      },
    };
    return { presets, simple };
  }, [t]);
}

export function useToolEvalCategories(): Record<string, string> {
  const { t } = useTranslation("tooleval");
  return useMemo(() => ({
    A: t("metadata.category.A"),
    B: t("metadata.category.B"),
    C: t("metadata.category.C"),
    D: t("metadata.category.D"),
    E: t("metadata.category.E"),
    F: t("metadata.category.F"),
    G: t("metadata.category.G"),
    H: t("metadata.category.H"),
    I: t("metadata.category.I"),
    J: t("metadata.category.J"),
    K: t("metadata.category.K"),
    L: t("metadata.category.L"),
    M: t("metadata.category.M"),
    N: t("metadata.category.N"),
    O: t("metadata.category.O"),
    P: t("metadata.category.P"),
  }), [t]);
}
