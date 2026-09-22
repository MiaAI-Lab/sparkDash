/** Sparky-style in-flight line. Null when nothing is actually decoding. */
export function formatLiveStrip(running: number | null | undefined, generationTps: number): string | null {
  const n = Math.round(Number(running) || 0);
  if (n <= 0 || !(generationTps > 0)) return null;
  const each = generationTps / n;
  const eachTxt = each >= 100 ? each.toFixed(0) : each.toFixed(1);
  const combTxt = generationTps >= 100 ? generationTps.toFixed(0) : generationTps.toFixed(1);
  return `${n} live · ~${eachTxt} tok/s each · ${combTxt} combined`;
}
