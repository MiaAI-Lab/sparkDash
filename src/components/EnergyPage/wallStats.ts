import type { EnergyHistory, EnergyHistoryRow, MonthlyEnergyMonth } from "../../api/types";
import { HOUR_MS } from "./energyStats";

/**
 * Wall power on the Energy page. The tracker sends wall figures (measured, gaps filled from
 * the estimate) beside the estimate's own; these helpers re-express them in the estimate's
 * row and month shapes, so summaries, buckets, insights and CSV run unchanged on either. Once
 * wall power is measured the raw estimate is not shown: it only fills gaps, scaled.
 */

/** True when the payload carries wall power (power meters are configured). */
export function hasWall(history: EnergyHistory | null | undefined): boolean {
  return (history?.wallNodeIds?.length ?? 0) > 0;
}

const add = (a: Record<string, number> | undefined, b: Record<string, number> | undefined, ids: readonly string[]) =>
  Object.fromEntries(ids.map((id) => [id, (a?.[id] ?? 0) + (b?.[id] ?? 0)]));

/**
 * Rows on a wall basis: per-node energy and coverage are measured plus filled; fleet
 * figures are the wall fleet's. Hours without any wall figure are left out, as gaps.
 */
export function wallRows(rows: readonly EnergyHistoryRow[], nodeIds: readonly string[]): EnergyHistoryRow[] {
  return rows
    .filter((r) => r.nodeWallWh || r.nodeWallFilledWh)
    .map((r) => ({
      t: r.t,
      nodeWh: add(r.nodeWallWh, r.nodeWallFilledWh, nodeIds),
      nodeCoverageMs: add(r.nodeWallCoverageMs, r.nodeWallFilledMs, nodeIds),
      avgWatts: r.avgWallWatts ?? null,
      fleetEnergyWh: r.fleetWallWh ?? 0,
      fleetCoverageMs: r.fleetWallCoverageMs ?? 0,
      outputTokens: r.outputTokens,
      coveredOutputTokens: r.wallCoveredOutputTokens ?? 0,
    }));
}

/** Share of the wall energy in `rows` that was filled from the estimate, 0..1. */
export function filledShare(rows: readonly EnergyHistoryRow[]): number {
  let total = 0;
  let filled = 0;
  for (const r of rows) {
    for (const v of Object.values(r.nodeWallWh ?? {})) total += v;
    for (const v of Object.values(r.nodeWallFilledWh ?? {})) {
      total += v;
      filled += v;
    }
  }
  return total > 0 ? filled / total : 0;
}

export interface NodeParts {
  gpuKwh: number;
  cpuKwh: number;
  measuredKwh: number;
  filledKwh: number;
}

/** Per node over `rows`: GPU and CPU energy, and measured vs filled wall energy. */
export function nodeParts(rows: readonly EnergyHistoryRow[], nodeIds: readonly string[]): Map<string, NodeParts> {
  const out = new Map(nodeIds.map((id) => [id, { gpuKwh: 0, cpuKwh: 0, measuredKwh: 0, filledKwh: 0 }]));
  for (const r of rows) {
    for (const id of nodeIds) {
      const n = out.get(id)!;
      n.gpuKwh += (r.nodeGpuWh?.[id] ?? 0) / 1000;
      n.cpuKwh += (r.nodeCpuWh?.[id] ?? 0) / 1000;
      n.measuredKwh += (r.nodeWallWh?.[id] ?? 0) / 1000;
      n.filledKwh += (r.nodeWallFilledWh?.[id] ?? 0) / 1000;
    }
  }
  return out;
}

export interface HourLines {
  gpu: number | null;
  cpu: number | null;
}

/**
 * Fleet GPU and CPU watts per hour, drawn over wall power. A line is only drawn for an hour
 * every node reported in.
 */
export function hourLines(rows: readonly EnergyHistoryRow[], nodeIds: readonly string[]): Map<number, HourLines> {
  const out = new Map<number, HourLines>();
  const fleetWatts = (wh: Record<string, number> | undefined, cov: Record<string, number> | undefined) => {
    if (!wh || !cov || nodeIds.some((id) => !(cov[id] > 0))) return null;
    return nodeIds.reduce((sum, id) => sum + (wh[id] ?? 0) / (cov[id] / HOUR_MS), 0);
  };
  for (const r of rows) {
    out.set(r.t, {
      gpu: fleetWatts(r.nodeGpuWh, r.nodePartsCoverageMs),
      cpu: fleetWatts(r.nodeCpuWh, r.nodePartsCoverageMs),
    });
  }
  return out;
}

/** A month on a wall basis, or null when it has no wall figures (it is shown estimated). */
export function wallMonth(m: MonthlyEnergyMonth): MonthlyEnergyMonth | null {
  if (m.totalWallWh == null) return null;
  const nodeIds = m.nodeIds.filter((id) => (m.nodes[id]?.wallCoverageMs ?? 0) + (m.nodes[id]?.wallFilledMs ?? 0) > 0);
  return {
    ...m,
    nodeIds,
    nodes: Object.fromEntries(
      nodeIds.map((id) => {
        const n = m.nodes[id];
        return [id, { wh: (n.wallWh ?? 0) + (n.wallFilledWh ?? 0), coverageMs: (n.wallCoverageMs ?? 0) + (n.wallFilledMs ?? 0) }];
      })
    ),
    totalWh: m.totalWallWh,
    fleetWh: m.fleetWallWh ?? 0,
    fleetCoverageMs: m.fleetWallCoverageMs ?? 0,
    coveredOutputTokens: m.wallCoveredOutputTokens ?? 0,
    whPerOutputToken: m.wallWhPerOutputToken ?? null,
  };
}

/** "141%" for a ratio of 1.41. */
export function formatRatio(r: number | null | undefined): string {
  return r == null ? "—" : `${Math.round(r * 100)}%`;
}
