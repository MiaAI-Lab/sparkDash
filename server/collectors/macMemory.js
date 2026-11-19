const MEMORY_KEYS = [
  "hw.memsize", "hw.pagesize", "vm.page_pageable_internal_count", "vm.page_pageable_external_count",
  "vm.page_free_count", "vm.page_wired_count", "vm.page_purgeable_count",
  "kern.memorystatus_vm_pressure_level", "vm.swapusage",
];

export const MAC_MEMORY_CMD = `sysctl ${MEMORY_KEYS.join(" ")} 2>/dev/null; vm_stat 2>/dev/null`;

/** Native macOS pressure levels; absent or unsupported readings remain unknown. */
export function macMemoryPressure(level) {
  return ({ 1: "normal", 2: "warning", 4: "critical" })[String(level).trim()] ?? "unknown";
}

/** Disjoint physical RAM slices in MiB from direct kernel counters, or an unavailable breakdown. */
export function macMemoryFromOutput(output) {
  const values = Object.fromEntries(String(output).split("\n").map((line) => {
    const i = line.indexOf(":");
    return i > 0 ? [line.slice(0, i).trim(), line.slice(i + 1).trim()] : [];
  }).filter((pair) => pair.length === 2));
  const memoryPressure = macMemoryPressure(values["kern.memorystatus_vm_pressure_level"]);
  const result = { memoryPressure, oomRisk: ({ normal: "low", warning: "medium", critical: "high" })[memoryPressure] ?? null, physical: null };
  const swap = values["vm.swapusage"];
  if (swap) {
    const read = (key) => {
      const m = swap.match(new RegExp(`${key}\\s*=\\s*([\\d.]+)([KMG])`));
      return m ? Math.round(Number(m[1]) * ({ K: 1 / 1024, M: 1, G: 1024 })[m[2]]) : null;
    };
    const parsed = { total: read("total"), used: read("used"), free: read("free") };
    if (Object.values(parsed).every((n) => n != null)) result.swap = parsed;
  }
  const numbers = MEMORY_KEYS.slice(0, 7).map((key) => /^\d+$/.test(values[key] ?? "") ? Number(values[key]) : NaN);
  const [bytes, pageSize, internal, external, freePages, wiredPages, purgeable] = numbers;
  const compressed = String(output).match(/^Pages occupied by compressor:\s+(\d+)/m);
  if (!numbers.every(Number.isSafeInteger) || bytes <= 0 || pageSize <= 0 || purgeable > internal || !compressed) return result;
  const toMB = (pages) => pages * pageSize / 1048576;
  const physical = {
    apps: toMB(internal - purgeable),
    wired: toMB(wiredPages),
    compressed: toMB(Number(compressed[1])),
    cached: toMB(external + purgeable),
    free: toMB(freePages),
    other: 0,
  };
  const total = bytes / 1048576;
  physical.other = total - Object.values(physical).reduce((sum, n) => sum + n, 0);
  if (physical.other < 0) return result;
  const available = Math.round(physical.cached + physical.free);
  const used = Math.round(total) - available;
  return { ...result, physical, total: Math.round(total), used, available, percentage: Math.round(used / total * 100) };
}
