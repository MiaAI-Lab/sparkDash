/**
 * Fleet exceptions: the Overview strip's conditions (offline, thermal / hardware
 * throttle, disk, LLM, tailnet). One copy, read by the strip in the browser
 * (FleetAlertStrip.deriveAlerts) and by the server's alert notifications
 * (server/alerts/conditions.js), so the two can never disagree on what is wrong.
 */

/** @param {number} c @param {"celsius"|"fahrenheit"} unit */
export function formatTemperature(c, unit = "celsius") {
  return unit === "fahrenheit" ? `${Math.round((c * 9) / 5 + 32)}°F` : `${Math.round(c)}°C`;
}

/**
 * The exceptions one unit has right now, in the strip's order.
 * @param {any} spark a SparkMonitor snapshot
 * @param {"celsius"|"fahrenheit"} [unit]
 * @returns {Array<{ id: "offline"|"throttle"|"disk"|"llm"|"tailnet", label: string, detail?: string, severity: "critical"|"warning" }>}
 */
export function fleetExceptions(spark, unit = "celsius") {
  const out = [];
  if (!spark) return out;
  const metrics = spark.metrics || {};
  if (!spark.online) out.push({ id: "offline", label: "Host unreachable", severity: "critical" });
  const th = metrics.gpu?.throttle;
  // A software power cap on an idle GPU is normal; only thermal / hardware slowdown is an alert.
  if (th?.thermal || th?.hwSlowdown) {
    const bits = [];
    const temp = metrics.gpu?.temperature;
    if (temp) bits.push(`GPU at ${formatTemperature(temp, unit)}`);
    if (th.smClockMHz) bits.push(`SM clock ${(th.smClockMHz / 1000).toFixed(1)} GHz${th.smClockPct != null ? ` (${Math.round(th.smClockPct)}% of max)` : ""}`);
    out.push({
      id: "throttle",
      label: th.thermal ? "is thermal throttling" : "has a hardware slowdown",
      detail: [th.detail, ...bits].filter(Boolean).join(" · "),
      severity: "critical",
    });
  }
  const storage = Array.isArray(metrics.storage) ? metrics.storage : [];
  if (storage.some((disk) => disk.percentage >= 90)) out.push({ id: "disk", label: "storage is at or above 90%", severity: "warning" });
  const llm = Array.isArray(metrics.llm) ? metrics.llm : [];
  if (spark.llmMonitoring !== false && llm.length > 0 && llm.every((l) => !l.available)) out.push({ id: "llm", label: "LLM is unavailable", severity: "warning" });
  const ts = metrics.tailscale;
  if (spark.tailscaleMonitoring && ts && (!ts.available || ts.online === false)) out.push({ id: "tailnet", label: "tailnet is unavailable", severity: "warning" });
  return out;
}
