/**
 * Short GPU name for the per-card rows.
 * "NVIDIA GeForce RTX 5080" -> "RTX 5080"; "Intel(R) Arc(TM) A770 Graphics" -> "Intel Arc A770".
 * The Intel vendor stays in the name so a mixed host reads clearly.
 */
export function shortGpuName(name: string | null): string {
  if (!name) return "";
  if (/^intel/i.test(name)) {
    return name
      .replace(/\((R|TM)\)/gi, "")
      .replace(/\s+graphics$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return name.replace(/^NVIDIA\s+(GeForce\s+)?/i, "");
}
