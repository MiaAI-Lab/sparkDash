import { useMemo } from "react";
import type { ModelTier, SparkSnapshot, StorageMetrics } from "../../api/types";
import { MetricBar } from "../ui/MetricBar";
import { Panel } from "../ui/Panel";
import { DiskIcon } from "../ui/icons";
import { resolvePlacement, rollupTierGb } from "./fleetPlacement";

interface FleetStoragePageProps {
  sparks: SparkSnapshot[];
}

const TIERS: ModelTier[] = ["hot", "warm", "cold"];

const TIER_TONE: Record<ModelTier, string> = {
  hot: "bg-accent text-accent",
  warm: "bg-warning text-black",
  cold: "bg-muted text-black",
};

function fmtGb(mb: number): string {
  const gb = mb / 1024;
  return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

function fmtBytes(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const m = bytes / 1024 / 1024;
  return `${Math.round(m)} MB`;
}

function TierChip({ tier }: { tier: ModelTier }) {
  const label = tier === "hot" ? "Hot" : tier === "warm" ? "Warm" : "Cold";
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${TIER_TONE[tier]}`}
    >
      {label}
    </span>
  );
}

export function FleetStoragePage({ sparks }: FleetStoragePageProps) {
  const tierGb = useMemo(() => rollupTierGb(sparks), [sparks]);
  const placement = useMemo(() => resolvePlacement(sparks), [sparks]);
  const replicated = placement.filter((p) => p.resident.length > 1).length;
  const fabric = placement.filter((p) => p.fabric.length > 0).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-overview-rhythm)" }}>
      <div className="flex flex-wrap items-end justify-between gap-6">
        <h1
          className="font-normal leading-tight tracking-tight text-text-strong"
          style={{ fontSize: "var(--density-overview-title)" }}
        >
          Storage
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          {TIERS.map((t) => (
            <span key={t} className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 text-[11px] text-muted">
              <TierChip tier={t} />
              <span className="font-tabular text-text-strong">{fmtGb(tierGb[t])}</span>
              <span>used</span>
            </span>
          ))}
          <span className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 text-[11px] text-muted">
            <span className="font-tabular text-text-strong">{replicated}</span> replicated
          </span>
          <span className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 text-[11px] text-muted">
            <span className="font-tabular text-text-strong">{fabric}</span> on CX7 fabric
          </span>
        </div>
      </div>

      {/* Per-Spark tier cards */}
      <div className="overview-page grid sm:grid-cols-2 lg:grid-cols-3" style={{ gap: "var(--density-page-gap)" }}>
        {sparks.map((spark) => (
          <SparkTierCard key={spark.id} spark={spark} />
        ))}
      </div>

      {/* Model placement table */}
      <Panel title="Model placement" accent icon={<DiskIcon />} className="panel-storage">
        {placement.length === 0 ? (
          <p className="text-xs text-muted">
            No models discovered. Configure <code className="rounded bg-surface-elevated px-1">modelDirs</code> per tier for each Spark in sparks.json.
          </p>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
                <th className="py-1.5 pr-3 font-medium">Model</th>
                <th className="py-1.5 pr-3 font-medium">Size</th>
                <th className="py-1.5 font-medium">Placement</th>
              </tr>
            </thead>
            <tbody>
              {placement.map((p) => (
                <tr key={p.name} className="border-t border-border">
                  <td className="py-2 pr-3 align-top">
                    <span className="font-tabular break-all text-text-strong">{p.name}</span>
                  </td>
                  <td className="py-2 pr-3 align-top font-tabular text-muted">
                    {fmtBytes(p.resident[0]?.tier ? byteSizeFor(p, sparks) : 0)}
                  </td>
                  <td className="py-2 align-top">
                    <div className="flex flex-wrap gap-1">
                      {p.resident.map((r) => (
                        <span key={`${r.sparkId}:${r.tier}`} className="inline-flex items-center gap-1 rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] text-text">
                          {r.sparkName}
                          <TierChip tier={r.tier} />
                        </span>
                      ))}
                      {p.fabric.map((f) => (
                        <span key={f.sparkId} className="inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
                          {f.sparkName} · fabric
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-[10px] text-muted">
          Resident = local disk copy. “fabric” = this Spark loads the model over the CX7 link from a peer’s copy (no local copy).
        </p>
      </Panel>
    </div>
  );
}

function byteSizeFor(
  p: { name: string },
  sparks: SparkSnapshot[]
): number {
  for (const s of sparks) {
    const m = (Array.isArray(s.metrics?.models) ? s.metrics.models : []).find(
      (x) => x.name === p.name
    );
    if (m) return m.sizeBytes;
  }
  return 0;
}

function SparkTierCard({ spark }: { spark: SparkSnapshot }) {
  const disks: StorageMetrics[] = Array.isArray(spark.metrics?.storage)
    ? spark.metrics.storage.filter((d) => !d.disabled)
    : [];
  const tierAgg: Record<ModelTier, { used: number; total: number }> = {
    hot: { used: 0, total: 0 },
    warm: { used: 0, total: 0 },
    cold: { used: 0, total: 0 },
  };
  for (const d of disks) {
    const t = d.tier;
    if (t === "hot" || t === "warm" || t === "cold") {
      tierAgg[t].used += d.used || 0;
      tierAgg[t].total += d.total || 0;
    }
  }
  return (
    <div
      className="overview-card flex flex-col"
      style={{ padding: "var(--density-card-pad)", gap: "var(--density-card-gap)" }}
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${spark.online ? "bg-success dot-glow-success" : "bg-danger"}`} />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text-strong">{spark.name}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted">{spark.online ? "online" : "offline"}</span>
      </div>
      <div className="flex flex-col gap-3">
        {TIERS.map((t) =>
          tierAgg[t].total > 0 ? (
            <div key={t} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  <TierChip tier={t} />
                </span>
                <span className="font-tabular text-muted">
                  {fmtGb(tierAgg[t].used)} / {fmtGb(tierAgg[t].total)}
                </span>
              </div>
              <MetricBar label={t} value={tierAgg[t].used} max={tierAgg[t].total} />
            </div>
          ) : null
        )}
        {TIERS.every((t) => tierAgg[t].total === 0) && (
          <p className="text-xs text-muted">No tiered storage detected</p>
        )}
      </div>
    </div>
  );
}
