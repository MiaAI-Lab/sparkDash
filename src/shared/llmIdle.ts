import { formatSince } from "./formatSince";

interface LlmRates {
  generationTps: number;
  prefillTps: number;
  /** A prompt is mid-prefill (engines that publish counters only when a request finishes). */
  prefillActive?: boolean;
  /** A request is decoding even when the engine has not reported a rate. */
  decodeActive?: boolean;
}

const serving = (tps: number) => Number.isFinite(tps) && tps > 0;

/**
 * True when the endpoint is neither generating nor prefilling right now. A prompt
 * that is mid-prefill counts as serving even while both rates read 0.
 */
export function isLlmIdle(llm: LlmRates): boolean {
  if (llm.prefillActive === true || llm.decodeActive === true) return false;
  return !serving(llm.generationTps) && !serving(llm.prefillTps);
}

/**
 * "Idle · last served 12m ago", or plain "Idle" when the server has not seen
 * the endpoint serve since it started (lastActiveAt is in-memory only).
 */
export function idleLabel(lastActiveAt: number | null | undefined, now: number = Date.now()): string {
  const since = formatSince(lastActiveAt, now);
  return since ? `Idle · last served ${since} ago` : "Idle";
}
