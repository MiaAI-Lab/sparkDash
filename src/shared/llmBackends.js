/**
 * Display labels for the backends `LlmProbe` reports.
 *
 * Shared so the LLM panel badge and the benchmark share card cannot drift apart
 * on what a backend is called — "TensorFold" on the card has to be the same word
 * the panel shows.
 */
export const BACKEND_LABELS = Object.freeze({
  vllm: "vLLM",
  "llama.cpp": "llama.cpp",
  sglang: "SGLang",
  lmstudio: "LM Studio",
  ollama: "Ollama",
  ds4: "ds4",
  exl3: "EXL3",
  q27: "q27",
  tensorfold: "TensorFold",
  freetoken: "FreeToken",
});

/**
 * @param {string | null | undefined} backend Backend id from `LlmMetrics`.
 * @returns {string | null} Label, the raw id when it is unknown, or null.
 */
export function backendLabel(backend) {
  if (backend == null || backend === "") return null;
  return BACKEND_LABELS[backend] || String(backend);
}
