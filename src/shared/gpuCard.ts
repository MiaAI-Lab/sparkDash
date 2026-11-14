import type { GpuPcieLink, GpuThrottle } from "../api/types";

/** "30 %" for a fan speed in percent; "—" when the card reports none (a GB10, a passively cooled card). */
export function formatFan(fanPct: number | null | undefined): string {
  return fanPct == null ? "—" : `${Math.round(fanPct)} %`;
}

function link(gen: number | null, width: number | null): string {
  return `Gen ${gen ?? "?"} x${width ?? "?"}`;
}

/**
 * The PCIe link as "Gen 3 x16", plus the best link the card can do ("Gen 4 x16") when that differs. A card parks its link
 * at a lower generation when idle, so a lower value than the best is normal at rest and worth a look under load.
 * Returns null when the link is unknown.
 */
export function pcieLinkText(pcie: GpuPcieLink | null | undefined): { now: string; best: string | null } | null {
  if (!pcie || (pcie.gen == null && pcie.width == null)) return null;
  const genMax = pcie.genMax ?? pcie.gen;
  const widthMax = pcie.widthMax ?? pcie.width;
  const same = genMax === pcie.gen && widthMax === pcie.width;
  return { now: link(pcie.gen, pcie.width), best: same ? null : link(genMax, widthMax) };
}

export type ThrottleReason = { reason: "thermal" | "power" | "hw" } | { reason: "clockCap"; mhz: number };

/** The active throttle reasons, in the order nvidia-smi ranks them; empty when clocks are not limited. */
export function throttleReasons(throttle: GpuThrottle | null | undefined): ThrottleReason[] {
  if (!throttle) return [];
  const out: ThrottleReason[] = [];
  if (throttle.thermal) out.push({ reason: "thermal" });
  if (throttle.powerCap) out.push({ reason: "power" });
  if (throttle.hwSlowdown && !throttle.thermal) out.push({ reason: "hw" });
  if (throttle.clockCapMHz != null) out.push({ reason: "clockCap", mhz: throttle.clockCapMHz });
  return out;
}
