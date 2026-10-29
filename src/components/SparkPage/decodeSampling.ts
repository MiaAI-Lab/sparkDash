import type { DecodeBenchConfig } from "../../api/types";

/** "temp 0.7 · thinking on". Runs saved before these options existed ran at temp 0 with thinking off. */
export function decodeBenchSamplingLabel(config: Pick<DecodeBenchConfig, "temperature" | "thinking" | "topK"> | null | undefined): string {
  const temp = typeof config?.temperature === "number" ? config.temperature : 0;
  const thinking = typeof config?.thinking === "boolean" ? config.thinking : false;
  const topK = config?.topK != null ? ` · top_k ${config.topK}` : "";
  return `temp ${temp} · thinking ${thinking ? "on" : "off"}${topK}`;
}

/** True when the runs used more than one temperature / thinking setting, so their tok/s are not comparable. */
export function decodeBenchSamplingMixed(configs: Array<Pick<DecodeBenchConfig, "temperature" | "thinking" | "topK"> | null | undefined>): boolean {
  return new Set(configs.map(decodeBenchSamplingLabel)).size > 1;
}
