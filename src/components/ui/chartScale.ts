/** Pure helpers shared by the bar / line charts. */

/** Round `max` up to a "nice" axis maximum and pick tick values (0 … niceMax). */
export function niceScale(max: number, targetTicks = 4): { max: number; ticks: number[] } {
  if (!Number.isFinite(max) || max <= 0) return { max: 1, ticks: [0, 1] };
  const rough = max / targetTicks;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const frac = rough / pow;
  const step = (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10) * pow;
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= niceMax + step / 1000; v += step) ticks.push(Number(v.toPrecision(12)));
  return { max: niceMax, ticks };
}

/** Indexes of x labels to draw so they never crowd: roughly one every `minPx` pixels. */
export function labelIndexes(count: number, widthPx: number, minPx = 56): number[] {
  if (count <= 0) return [];
  const slots = Math.max(1, Math.floor(widthPx / minPx));
  const every = Math.max(1, Math.ceil(count / slots));
  const out: number[] = [];
  // Anchor on the last bar so "now" / "today" is always labelled.
  for (let i = count - 1; i >= 0; i -= every) out.unshift(i);
  return out;
}
