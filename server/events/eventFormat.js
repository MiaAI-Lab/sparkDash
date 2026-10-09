/** Human-readable event builders shared by index.js, monitors and benches. */

const BENCH_LABEL = { decode: "Decode bench", prefill: "Prefill bench", quality: "Quality bench" };

/**
 * Build an event input for a finished bench job.
 * @param {"decode"|"prefill"|"quality"} kind
 * @param {{ status: string, error?: string|null, results?: any }} job
 * @param {string} sparkName
 */
export function benchEvent(kind, job, sparkName) {
  const label = BENCH_LABEL[kind] || "Bench";
  const name = sparkName || "spark";
  const status = job?.status;
  if (status === "completed") {
    let detail = "";
    if (kind === "quality" && Number.isFinite(job.results?.overallPct)) {
      detail = `: ${Math.round(job.results.overallPct * 10) / 10}%`;
    }
    return { type: `bench.${kind}.finished`, severity: "success", message: `${label} finished on ${name}${detail}` };
  }
  if (status === "cancelled") {
    return { type: `bench.${kind}.cancelled`, severity: "info", message: `${label} cancelled on ${name}` };
  }
  if (status === "failed") {
    const err = String(job?.error || "").split("\n")[0].slice(0, 120);
    return {
      type: `bench.${kind}.failed`,
      severity: "error",
      message: `${label} failed on ${name}${err ? `: ${err}` : ""}`,
    };
  }
  return null;
}
