import { formatSince } from "./formatSince";
import { i18next } from "../i18n";

interface LlmRates {
  generationTps: number;
  prefillTps: number;
}

const serving = (tps: number) => Number.isFinite(tps) && tps > 0;

/** True when the endpoint is neither generating nor prefilling right now. */
export function isLlmIdle(llm: LlmRates): boolean {
  return !serving(llm.generationTps) && !serving(llm.prefillTps);
}

/**
 * "Idle · last served 12m ago", or plain "Idle" when the server has not seen
 * the endpoint serve since it started (lastActiveAt is in-memory only).
 */
export function idleLabel(lastActiveAt: number | null | undefined, now: number = Date.now()): string {
  const since = formatSince(lastActiveAt, now);
  return since ? i18next.t("spark.idle.lastServed", "Idle · last served {since} ago", { since }) : i18next.t("spark.idle.label", "Idle");
}
